/*
 * Ballooning API adapter.
 *
 * The ballooning pages talk to `services/api` through exactly five methods
 * (get / post / put / delete / upload) and expect REST endpoints such as
 * `/projects/:id/balloons` to behave like the Express backend that shipped
 * with the ballooning zip (backend/server.js).
 *
 * This module keeps that contract byte-for-byte but stores everything inside
 * the browser, the way the rest of the ERP does:
 *
 *   - metadata (projects, balloons, characteristics, ...) -> localStorage
 *   - drawing files (PDF / PNG)                          -> IndexedDB
 *
 * Endpoint semantics mirror backend/server.js: same field defaults, same
 * sort orders, same cascade deletes, same response payloads. The only
 * intentional addition is POST /projects/:id/duplicate, which the zip's UI
 * offers (Copy) but its backend never implemented.
 */

const NS = 'ballooning_';
const IDB_NAME = 'BalloonDrawingFilesDB';
const IDB_VERSION = 1;
const IDB_STORE = 'drawings';

/* ------------------------------------------------------------------ */
/* localStorage helpers                                                */
/* ------------------------------------------------------------------ */

const readList = (key) => {
    try {
        const raw = localStorage.getItem(NS + key);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.error('Ballooning storage read failed', key, error);
        return [];
    }
};

const writeList = (key, list) => {
    try {
        localStorage.setItem(NS + key, JSON.stringify(list));
    } catch (error) {
        console.error('Ballooning storage write failed', key, error);
        throw new Error('Storage is full - please export and remove old projects.');
    }
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const uid = () => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

const nowIso = () => new Date().toISOString();

/* ------------------------------------------------------------------ */
/* IndexedDB file store (memory fallback when IndexedDB is missing)   */
/* ------------------------------------------------------------------ */

const memoryFiles = new Map();

const openDB = () =>
    new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB unavailable'));
            return;
        }
        const request = indexedDB.open(IDB_NAME, IDB_VERSION);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

const idbAvailable = typeof indexedDB !== 'undefined';

const fileStore = {
    async put(id, blob) {
        if (!idbAvailable) {
            memoryFiles.set(id, blob);
            return;
        }
        const db = await openDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(blob, id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
        db.close();
    },
    async get(id) {
        if (!idbAvailable) return memoryFiles.get(id) || null;
        try {
            const db = await openDB();
            const value = await new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_STORE, 'readonly');
                const request = tx.objectStore(IDB_STORE).get(id);
                request.onsuccess = () => resolve(request.result || null);
                request.onerror = () => reject(request.error);
            });
            db.close();
            return value || null;
        } catch (error) {
            return memoryFiles.get(id) || null;
        }
    },
    async remove(id) {
        if (!idbAvailable) {
            memoryFiles.delete(id);
            return;
        }
        try {
            const db = await openDB();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_STORE, 'readwrite');
                tx.objectStore(IDB_STORE).delete(id);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
            db.close();
        } catch (error) {
            memoryFiles.delete(id);
        }
    }
};

const objectUrlCache = new Map();

const toObjectUrl = async(drawingId) => {
    if (!drawingId) return '';
    if (objectUrlCache.has(drawingId)) return objectUrlCache.get(drawingId);
    const blob = await fileStore.get(drawingId);
    if (!blob || typeof URL === 'undefined' || !URL.createObjectURL) return '';
    const url = URL.createObjectURL(blob);
    objectUrlCache.set(drawingId, url);
    return url;
};

const releaseObjectUrl = (drawingId) => {
    const url = objectUrlCache.get(drawingId);
    if (url && typeof URL !== 'undefined' && URL.revokeObjectURL) {
        try {
            URL.revokeObjectURL(url);
        } catch (error) {
            /* ignore */
        }
    }
    objectUrlCache.delete(drawingId);
};

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

const parseEndpoint = (endpoint) => {
    const [pathPart, queryPart] = String(endpoint).split('?');
    const segments = pathPart.replace(/^\/+/, '').replace(/\/+$/, '').split('/').filter(Boolean);
    const query = {};
    if (queryPart) {
        for (const pair of queryPart.split('&')) {
            if (!pair) continue;
            const [rawKey, rawValue = ''] = pair.split('=');
            query[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
        }
    }
    return { segments, query };
};

const missing = (message) => {
    const error = new Error(message);
    error.status = 404;
    return error;
};

const withDefaults = (payload, defaults) => {
    const result = {...payload };
    Object.keys(defaults).forEach((key) => {
        if (result[key] === undefined || result[key] === null) result[key] = defaults[key];
    });
    return result;
};

const byCreatedAtDesc = (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0);

/* ------------------------------------------------------------------ */
/* Collections                                                         */
/* ------------------------------------------------------------------ */

const collections = {
    projects: 'projects',
    drawings: 'drawings',
    balloons: 'balloons',
    characteristics: 'characteristics',
    inspections: 'inspections',
    approvals: 'approvals'
};

const all = (name) => readList(collections[name]);
const persist = (name, items) => writeList(collections[name], items);

const find = (name, id) => all(name).find((entry) => entry._id === id) || null;

const updateIn = (name, id, patch) => {
    const items = all(name);
    const index = items.findIndex((entry) => entry._id === id);
    if (index < 0) return null;
    items[index] = {...items[index], ...patch };
    persist(name, items);
    return items[index];
};

const removeFrom = (name, predicate) => {
    const items = all(name);
    const kept = items.filter((entry) => !predicate(entry));
    persist(name, kept);
    return items.length - kept.length;
};

/* ------------------------------------------------------------------ */
/* Drawing file resolution                                             */
/* ------------------------------------------------------------------ */

const decorateDrawing = async(drawing) => {
    if (!drawing) return drawing;
    const filePath = await toObjectUrl(drawing._id);
    return {...drawing, filePath: filePath || drawing.filePath || '' };
};

const decorateDrawings = async(drawings) => {
    const out = [];
    for (const drawing of drawings) out.push(await decorateDrawing(drawing));
    return out;
};

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

const handleHealth = () => ({ status: 'ok' });

const createProject = (body = {}) => {
    const payload = withDefaults({...body, createdBy: body.createdBy || 'Admin', createdAt: nowIso(), updatedAt: nowIso() }, { unit: 'mm', status: 'Draft' });
    const project = { _id: uid(), ...payload };
    const projects = all('projects');
    projects.push(project);
    persist('projects', projects);

    const inspections = all('inspections');
    inspections.push({
        _id: uid(),
        projectId: project._id,
        inspector: project.inspector,
        reviewer: project.reviewer,
        status: 'Draft',
        comments: '',
        approvedBy: '',
        approvedDate: null,
        createdAt: nowIso(),
        updatedAt: nowIso()
    });
    persist('inspections', inspections);
    return project;
};

const duplicateProject = (projectId) => {
    const source = find('projects', projectId);
    if (!source) throw missing('Project not found');

    const stamp = nowIso();
    const copy = {...clone(source), _id: uid(), status: 'Draft', createdAt: stamp, updatedAt: stamp };
    const projects = all('projects');
    projects.unshift(copy);
    persist('projects', projects);

    const drawingIdMap = new Map();
    const balloonIdMap = new Map();
    const drawings = all('drawings').filter((entry) => entry.projectId === projectId);

    for (const drawing of drawings) {
        const newId = uid();
        drawingIdMap.set(drawing._id, newId);
        const file = fileStore.get(drawing._id);
        Promise.resolve(file).then((blob) => {
            if (blob) fileStore.put(newId, blob);
        });
        persist('drawings', [
            ...all('drawings'),
            {...clone(drawing), _id: newId, projectId: copy._id, uploadedAt: stamp, updatedAt: stamp }
        ]);
    }

    const balloons = all('balloons').filter((entry) => entry.projectId === projectId);
    const copiedBalloons = balloons.map((balloon) => {
        const newId = uid();
        balloonIdMap.set(balloon._id, newId);
        return {
            ...clone(balloon),
            _id: newId,
            projectId: copy._id,
            drawingId: drawingIdMap.get(balloon.drawingId) || balloon.drawingId,
            createdAt: stamp,
            updatedAt: stamp
        };
    });
    if (copiedBalloons.length) persist('balloons', [...all('balloons'), ...copiedBalloons]);

    const characteristics = all('characteristics').filter((entry) => entry.projectId === projectId);
    const copiedCharacteristics = characteristics.map((item) => ({
        ...clone(item),
        _id: uid(),
        projectId: copy._id,
        drawingId: drawingIdMap.get(item.drawingId) || item.drawingId,
        balloonId: balloonIdMap.get(item.balloonId) || item.balloonId
    }));
    if (copiedCharacteristics.length) {
        persist('characteristics', [...all('characteristics'), ...copiedCharacteristics]);
    }

    return copy;
};

const uploadDrawing = async(projectId, formData) => {
    const file = formData && typeof formData.get === 'function' ? formData.get('drawing') : null;
    if (!file) throw new Error('No file uploaded');

    const drawingNo =
        formData && typeof formData.get === 'function' ? String(formData.get('drawingNo') || '').trim() : '';

    const stamp = nowIso();
    const drawing = {
        _id: uid(),
        projectId,
        fileName: file.name || 'drawing.pdf',
        drawingNo,
        filePath: '',
        pageCount: 1,
        uploadedAt: stamp,
        updatedAt: stamp
    };

    await fileStore.put(drawing._id, file);
    persist('drawings', [...all('drawings'), drawing]);
    return decorateDrawing(drawing);
};

/**
 * A project's drawings newest-first. Two uploads in the same millisecond get an
 * identical `uploadedAt`, so insertion order (later entry = newer) breaks the tie
 * and the newest upload can never lose to a stable-sort artifact.
 */
const listProjectDrawingsNewestFirst = (projectId) => {
    const stored = all('drawings');
    return stored
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.projectId === projectId)
        .sort(
            (a, b) =>
            new Date(b.entry.uploadedAt || 0) - new Date(a.entry.uploadedAt || 0) || b.index - a.index
        )
        .map(({ entry }) => entry);
};

const deleteDrawing = async(drawingId) => {
    const drawings = all('drawings');
    const drawing = drawings.find((entry) => entry._id === drawingId);
    if (!drawing) throw missing('Drawing not found');
    persist('drawings', drawings.filter((entry) => entry._id !== drawingId));
    releaseObjectUrl(drawingId);
    await fileStore.remove(drawingId);

    // Remove this drawing's balloons and characteristics so a new drawing
    // in the same project never inherits stale balloons.
    const orphanBalloonIds = all('balloons')
        .filter((entry) => entry.drawingId === drawingId)
        .map((entry) => entry._id);
    if (orphanBalloonIds.length) {
        persist(
            'balloons',
            all('balloons').filter((entry) => entry.drawingId !== drawingId)
        );
        persist(
            'characteristics',
            all('characteristics').filter((entry) => !orphanBalloonIds.includes(entry.balloonId))
        );
    }

    return { success: true };
};

const listBalloons = (projectId, query) => {
    let items = all('balloons').filter((entry) => entry.projectId === projectId);
    if (query.drawingId) items = items.filter((entry) => entry.drawingId === query.drawingId);
    return items.sort((a, b) => Number(a.number || 0) - Number(b.number || 0));
};

const createBalloon = (projectId, body = {}) => {
    const count = all('balloons').filter((entry) => entry.projectId === projectId).length;
    const payload = {
        projectId,
        ...body,
        number: body.number || count + 1,
        status: body.status || 'Draft',
        createdAt: nowIso(),
        updatedAt: nowIso()
    };
    const balloon = { _id: uid(), ...payload };
    persist('balloons', [...all('balloons'), balloon]);
    return balloon;
};

const deleteBalloon = (balloonId) => {
    const balloon = find('balloons', balloonId);
    if (!balloon) throw missing('Balloon not found');
    removeFrom('balloons', (entry) => entry._id === balloonId);
    removeFrom('characteristics', (entry) => entry.balloonId === balloonId);
    return { success: true, balloon };
};

const listCharacteristics = (projectId, query) => {
    let items = all('characteristics').filter((entry) => entry.projectId === projectId);
    if (query.drawingId) items = items.filter((entry) => entry.drawingId === query.drawingId);
    return items;
};

const createApproval = (projectId, body = {}) => {
    const status = body.status || 'Submitted for Review';
    const approval = { _id: uid(), projectId, ...body, status, createdAt: nowIso() };
    persist('approvals', [...all('approvals'), approval]);

    const project = find('projects', projectId);
    if (project) updateIn('projects', projectId, { status: body.status || 'Under Review' });
    return approval;
};

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

const route = async(method, endpoint, body = {}) => {
    const { segments, query } = parseEndpoint(endpoint);
    const [root, id, sub, subId] = segments;

    if (root === 'health') return handleHealth();

    if (root === 'projects') {
        if (!id) {
            if (method === 'GET') return [...all('projects')].sort(byCreatedAtDesc);
            if (method === 'POST') return createProject(body);
            throw new Error('Request failed');
        }

        if (sub === 'duplicate' && method === 'POST') return duplicateProject(id);

        if (sub === 'drawing' && method === 'POST') return uploadDrawing(id, body);

        if (sub === 'drawings' && method === 'GET') {
            return decorateDrawings(listProjectDrawingsNewestFirst(id));
        }

        if (sub === 'drawing' && method === 'GET') {
            const items = listProjectDrawingsNewestFirst(id);
            if (!items.length) throw missing('Drawing not found');
            return decorateDrawing(items[0]);
        }

        if (sub === 'drawings' && subId) {
            const drawing = find('drawings', subId);
            if (!drawing) throw missing('Drawing not found');
            if (method === 'PUT') {
                const updated = updateIn('drawings', subId, {...body, updatedAt: nowIso() });
                return decorateDrawing(updated);
            }
            if (method === 'DELETE') return deleteDrawing(subId);
            throw new Error('Request failed');
        }

        if (sub === 'balloons') {
            if (method === 'GET') return listBalloons(id, query);
            if (method === 'POST') return createBalloon(id, body);
            throw new Error('Request failed');
        }

        if (sub === 'characteristics') {
            if (method === 'GET') return listCharacteristics(id, query);
            if (method === 'POST') {
                const payload = { projectId: id, ...body };
                const item = { _id: uid(), ...payload };
                persist('characteristics', [...all('characteristics'), item]);
                return item;
            }
            throw new Error('Request failed');
        }

        if (sub === 'approval' && method === 'POST') return createApproval(id, body);

        if (sub === 'export' && method === 'POST') {
            return { success: true, message: 'Export placeholder ready' };
        }

        if (!sub) {
            const project = find('projects', id);
            if (!project) throw missing('Project not found');
            if (method === 'GET') return project;
            if (method === 'PUT') {
                return updateIn('projects', id, {...body, updatedAt: nowIso() });
            }
            if (method === 'DELETE') {
                removeFrom('projects', (entry) => entry._id === id);
                removeFrom('inspections', (entry) => entry.projectId === id);
                removeFrom('approvals', (entry) => entry.projectId === id);
                const goneBalloons = all('balloons').filter((entry) => entry.projectId === id);
                goneBalloons.forEach((entry) => releaseObjectUrl(entry._id));
                removeFrom('balloons', (entry) => entry.projectId === id);
                removeFrom('characteristics', (entry) => entry.projectId === id);
                const drawings = all('drawings').filter((entry) => entry.projectId === id);
                for (const drawing of drawings) {
                    releaseObjectUrl(drawing._id);
                    await fileStore.remove(drawing._id);
                }
                removeFrom('drawings', (entry) => entry.projectId === id);
                return { success: true };
            }
            throw new Error('Request failed');
        }

        throw new Error('Request failed');
    }

    if (root === 'balloons') {
        const balloon = find('balloons', id);
        if (!balloon) throw missing('Balloon not found');
        if (method === 'PUT') return updateIn('balloons', id, {...body, updatedAt: nowIso() });
        if (method === 'DELETE') return deleteBalloon(id);
        throw new Error('Request failed');
    }

    if (root === 'characteristics') {
        const item = find('characteristics', id);
        if (!item) throw missing('Characteristic not found');
        if (method === 'PUT') return updateIn('characteristics', id, body);
        if (method === 'DELETE') {
            removeFrom('characteristics', (entry) => entry._id === id);
            return { success: true };
        }
        throw new Error('Request failed');
    }

    if (root === 'auth') {
        throw new Error('Invalid credentials');
    }

    throw new Error('Request failed');
};

/* ------------------------------------------------------------------ */
/* Public surface - identical to services/api.js                       */
/* ------------------------------------------------------------------ */

const REMOTE_API = String(
    import.meta.env?.VITE_API_URL || 'http://localhost:3001/api/ballooning').replace(/\/$/, '');

const normalizeRemoteFilePaths = (value) => {
    if (Array.isArray(value)) return value.map(normalizeRemoteFilePaths);
    if (!value || typeof value !== 'object') return value;
    const copy = {...value };
    if (typeof copy.filePath === 'string' && copy.filePath.startsWith('/')) {
        copy.filePath = new URL(copy.filePath, REMOTE_API).toString();
    }
    return copy;
};

const remoteRequest = async(method, endpoint, body) => {
    const options = { method, headers: {} };
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
        options.body = body;
    } else if (body !== undefined && body !== null) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }

    let response;
    try {
        response = await fetch(`${REMOTE_API}/${String(endpoint).replace(/^\/+/, '')}`, options);
    } catch (error) {
        error.remoteUnavailable = true;
        throw error;
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(payload.error || payload.message || `Request failed (${response.status})`);
        error.status = response.status;
        throw error;
    }
    return normalizeRemoteFilePaths(payload);
};

const request = async(method, endpoint, body) => {
    try {
        return await remoteRequest(method, endpoint, body);
    } catch (error) {
        if (!error?.remoteUnavailable) throw error;
        return route(method, endpoint, body);
    }
};

const api = {
    get: (endpoint) => request('GET', endpoint),
    post: (endpoint, body) => request('POST', endpoint, body),
    put: (endpoint, body) => request('PUT', endpoint, body),
    delete: (endpoint) => request('DELETE', endpoint),
    upload: (endpoint, formData) => request('POST', endpoint, formData)
};

export default api;
export { all as __all, persist as __persist };