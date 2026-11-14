import { createHash, timingSafeEqual } from 'node:crypto';
import { MAX_PHOTO_BYTES, PHOTO_CHUNK_BYTES, PRODUCTS, photoCount } from '../../assets/shop-catalog.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const tokenMatches = (hash, token) => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) && timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(digest(token), 'hex'));
const response = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

function imageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

export async function verifyPhotos(store, selection, checkoutId, token) {
  if (!photoCount(selection)) return [];
  const keys = [];
  for (const photo of selection.photos) {
    const key = `photos/${checkoutId}/${photo.slot}`;
    const entry = await store.getMetadata(key);
    const meta = entry?.metadata;
    if (!meta || !tokenMatches(meta.tokenHash, token) || meta.name !== photo.name || meta.kind !== selection.kind || meta.quantity !== selection.quantity ||
        (meta.photoMode ?? 'different') !== (selection.photoMode ?? 'different')) {
      throw new Error('The required photos have not been securely saved for this order.');
    }
    keys.push(key);
  }
  return keys;
}

export function createPhotoHandler({ allowed, getStore, now = () => Date.now() }) {
  return async request => {
    try {
      if (!allowed(request)) return response({ error: 'Photo uploads are not connected for this environment.' }, 503);
      const url = new URL(request.url);
      if (request.method !== 'POST') return response({ error: 'Method not allowed.' }, 405);
      if (request.headers.get('origin') !== url.origin) return response({ error: 'Request origin is not allowed.' }, 403);
      if (!request.headers.get('content-type')?.startsWith('multipart/form-data;')) return response({ error: 'Use a photo upload form.' }, 415);
      // Transfer originals in bounded pieces below Netlify's binary request limit.
      const chunks = []; let size = 0;
      const reader = request.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > PHOTO_CHUNK_BYTES + 32768) { await reader.cancel(); return response({ error: 'Upload request is too large. Refresh the shop and choose the photo again.' }, 413); }
        chunks.push(value);
      }
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': request.headers.get('content-type') } }).formData();
      const checkoutId = form.get('checkoutId'); const token = form.get('token');
      const kind = form.get('kind'); const quantity = Number(form.get('quantity')); const slot = Number(form.get('slot'));
      const photoMode = kind === 'ornament' ? (form.get('photoMode') ?? 'different') : 'different';
      if (!UUID.test(checkoutId || '') || !TOKEN.test(token || '') || !['cube', 'ornament'].includes(kind) ||
          !['same', 'different'].includes(photoMode) ||
          !Number.isInteger(quantity) || quantity < 1 || quantity > (PRODUCTS[kind].maxQuantity || 20) ||
          !/^\d{1,2}$/.test(form.get('slot') || '') || !Number.isInteger(slot) || slot < 0 || slot >= photoCount({ kind, quantity, photoMode })) return response({ error: 'Invalid photo reference.' }, 400);
      const file = form.get('file');
      if (!file || typeof file.arrayBuffer !== 'function' || !file.size || file.size > PHOTO_CHUNK_BYTES) return response({ error: 'Choose a photo up to 10 MB and upload it through the shop.' }, 400);
      const name = file.name;
      if (!name || name.length > 100 || /[\u0000-\u001f\u007f<>\\/]/u.test(name)) return response({ error: 'Photo filename is not supported.' }, 400);
      const chunked = form.has('chunkIndex');
      const chunkIndex = chunked ? Number(form.get('chunkIndex')) : 0;
      const chunkCount = chunked ? Number(form.get('chunkCount')) : 1;
      const totalSize = chunked ? Number(form.get('totalSize')) : file.size;
      if ((chunked && ['chunkIndex', 'chunkCount', 'totalSize'].some(field => !/^\d+$/.test(form.get(field) || ''))) ||
          !Number.isSafeInteger(totalSize) || totalSize < 1 || totalSize > MAX_PHOTO_BYTES ||
          !Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= chunkCount ||
          chunkCount !== Math.ceil(totalSize / PHOTO_CHUNK_BYTES) ||
          file.size !== Math.min(PHOTO_CHUNK_BYTES, totalSize - chunkIndex * PHOTO_CHUNK_BYTES)) {
        return response({ error: 'Invalid photo upload size. Maximum 10 MB per photo.' }, 400);
      }
      let bytes = Buffer.from(await file.arrayBuffer());
      const type = file.type;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(type) || (chunkIndex === 0 && imageType(bytes) !== type)) return response({ error: 'Choose a valid JPG, PNG, or WebP photo.' }, 415);
      const store = getStore();
      if (await store.get(`drafts/${checkoutId}`, { type: 'json' })) return response({ error: 'Photos are locked to the existing checkout.' }, 409);
      const sessionKey = `photo-sessions/${checkoutId}`;
      await store.setJSON(sessionKey, { tokenHash: digest(token), kind, quantity, photoMode, expiresAt: now() + 3 * 60 * 60 * 1000 }, { onlyIfNew: true });
      const session = await store.get(sessionKey, { type: 'json' });
      if (!session || !tokenMatches(session.tokenHash, token) || session.kind !== kind || session.quantity !== quantity || (session.photoMode ?? 'different') !== photoMode) return response({ error: 'Photo session does not match.' }, 403);
      if (session.expiresAt < now()) return response({ error: 'Photo session expired. Start checkout again.' }, 410);
      const key = `photos/${checkoutId}/${slot}`;
      const identity = { tokenHash: digest(token), name, type, kind, quantity, photoMode, slot, size: totalSize, chunkCount };
      const existing = (await store.getMetadata(key))?.metadata;
      if (existing) {
        const same = tokenMatches(existing.tokenHash, token) && existing.name === name && existing.type === type &&
          existing.kind === kind && existing.quantity === quantity && (existing.photoMode ?? 'different') === photoMode &&
          (existing.size ?? totalSize) === totalSize &&
          (existing.chunkDigests?.[chunkIndex] ?? (chunkCount === 1 ? existing.digest : null)) === digest(bytes);
        return same ? response({ accepted: true, saved: true, slot, name }, 201) : response({ error: 'A different photo already occupies this slot.' }, 409);
      }
      const partKeys = [];
      const chunkDigests = [];
      if (chunkCount > 1) {
        const manifestKey = `photo-parts/${checkoutId}/${slot}/manifest`;
        await store.setJSON(manifestKey, identity, { onlyIfNew: true });
        const manifest = await store.get(manifestKey, { type: 'json' });
        if (!manifest || Object.entries(identity).some(([field, value]) => manifest[field] !== value)) return response({ error: 'Photo upload details changed. Select the photo again.' }, 409);
        const partKey = `photo-parts/${checkoutId}/${slot}/${chunkIndex}`;
        await store.set(partKey, bytes, { metadata: { digest: digest(bytes) }, onlyIfNew: true });
        if ((await store.getMetadata(partKey))?.metadata?.digest !== digest(bytes)) return response({ error: 'This photo upload part has changed.' }, 409);
        if (chunkIndex < chunkCount - 1) return response({ accepted: true, saved: false, slot }, 202);
        const originals = [];
        for (let index = 0; index < chunkCount; index++) {
          const pieceKey = `photo-parts/${checkoutId}/${slot}/${index}`;
          const piece = await store.get(pieceKey, { type: 'arrayBuffer' });
          const meta = (await store.getMetadata(pieceKey))?.metadata;
          if (!piece || Buffer.byteLength(piece) !== Math.min(PHOTO_CHUNK_BYTES, totalSize - index * PHOTO_CHUNK_BYTES) || digest(Buffer.from(piece)) !== meta?.digest) {
            return response({ error: 'Photo upload is incomplete. Please retry.' }, 409);
          }
          originals.push(Buffer.from(piece)); chunkDigests.push(meta.digest); partKeys.push(pieceKey);
        }
        bytes = Buffer.concat(originals);
        partKeys.push(manifestKey);
      } else chunkDigests.push(digest(bytes));
      if (bytes.length !== totalSize || imageType(bytes) !== type) return response({ error: 'Choose a valid JPG, PNG, or WebP photo up to 10 MB.' }, 415);
      const metadata = { ...identity, digest: digest(bytes), chunkDigests, createdAt: new Date(now()).toISOString() };
      await store.set(key, bytes, { metadata, onlyIfNew: true });
      const saved = await store.getMetadata(key);
      if (saved?.metadata?.digest !== metadata.digest || saved.metadata.name !== name || !tokenMatches(saved.metadata.tokenHash, token)) return response({ error: 'A different photo already occupies this slot.' }, 409);
      // The verified original is saved; remove temporary pieces without undoing success if cleanup fails.
      await Promise.all(partKeys.map(partKey => store.delete(partKey))).catch(() => {});
      return response({ accepted: true, saved: true, slot, name }, 201);
    } catch { return response({ error: 'Photo could not be saved. No payment was started. Please retry.' }, 503); }
  };
}
