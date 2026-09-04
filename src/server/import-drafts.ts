import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import {
  ImportDraftError,
  MAX_IMPORT_SOURCE_BYTES,
  MAX_VISUAL_EVIDENCE_BYTES,
  visualEvidenceSchema,
  type ImportDraftStore,
} from '../design-import/draft-store';
import { semanticNodeDirectiveSchema } from '../design-import/semantic-overlay';
import type { RegisteredProject } from './index';
import { UploadError } from '../upload';

const revisionSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
const planSchema = revisionSchema.extend({
  rootIds: z.array(z.string().min(1).max(1_024)).min(1).max(10_000)
    .refine((ids) => new Set(ids).size === ids.length, 'rootIds must be unique')
    .optional(),
}).strict();
const materializeSchema = revisionSchema.extend({ targetPath: z.string().trim().min(1).max(4_096) }).strict();
const semanticUpdateSchema = z.object({
  expectedRevision: z.number().int().positive(),
  nodeId: z.string().min(1).max(1_024),
  directive: semanticNodeDirectiveSchema,
}).strict();
const visualEvidenceInputSchema = visualEvidenceSchema.omit({ createdAt: true });
const createSchema = z.union([
  z.object({ sourcePath: z.string().trim().min(1).max(4_096) }).strict(),
  z.object({
    kind: z.enum(['fig', 'psd', 'bundle']),
    name: z.string().trim().min(1).max(255),
    files: z.array(z.object({
      path: z.string().min(1).max(1_024),
      size: z.number().int().nonnegative().max(MAX_IMPORT_SOURCE_BYTES),
    }).strict()).min(1).max(5_000),
  }).strict(),
]);

export function registerImportDraftApi(
  app: Hono,
  readState: () => {
    importDraftStore: ImportDraftStore;
    importsEnabled: boolean;
    ensureDraftPreview(draftId: string): Promise<RegisteredProject>;
    removeDraftPreview(draftId: string): void;
  },
) {
  return app
    .post(
      '/api/import-drafts',
      zValidator('json', createSchema),
      async (c) => {
        const { importDraftStore, importsEnabled } = readState();
        if (!importsEnabled) return readOnly(c);
        try {
          const input = c.req.valid('json');
          const draft = 'sourcePath' in input
            ? await importDraftStore.create(input.sourcePath)
            : await importDraftStore.createUpload(input);
          return c.json({ draft }, 201);
        } catch (error) {
          return draftError(c, error);
        }
      },
    )
    .get(
      '/api/import-drafts',
      zValidator('query', z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) })),
      (c) => {
        const { importDraftStore, importsEnabled } = readState();
        return importsEnabled
          ? c.json({ drafts: importDraftStore.list(c.req.valid('query').limit) })
          : readOnly(c);
      },
    )
    .get(
      '/api/import-drafts/:draftId/visual-evidence/:image',
      zValidator('param', z.object({ image: z.enum(['reference', 'capture', 'diff']) })),
      async (c) => {
        const { importDraftStore, importsEnabled } = readState();
        if (!importsEnabled) return readOnly(c);
        try {
          const data = await importDraftStore.readVisualEvidenceImage(c.req.param('draftId'), c.req.valid('param').image);
          c.header('Content-Type', 'image/png');
          c.header('Content-Length', String(data.byteLength));
          return c.body(Uint8Array.from(data).buffer);
        } catch (error) {
          return draftError(c, error);
        }
      },
    )
    .get('/api/import-drafts/:draftId', async (c) => {
      const { importDraftStore, importsEnabled, ensureDraftPreview } = readState();
      if (!importsEnabled) return readOnly(c);
      try {
        const detail = await importDraftStore.getDetail(c.req.param('draftId'));
        if (!detail) return c.json({ error: 'Import draft not found' }, 404);
        let preview: RegisteredProject | null = null;
        let previewError: string | null = null;
        if (detail.draft.generated) {
          try {
            preview = await ensureDraftPreview(detail.draft.draftId);
          } catch (error) {
            previewError = error instanceof Error ? error.message : String(error);
          }
        }
        return c.json({ ...detail, preview, previewError });
      } catch (error) {
        return draftError(c, error);
      }
    })
    .delete(
      '/api/import-drafts/:draftId',
      zValidator('query', z.object({ expectedRevision: z.coerce.number().int().positive() }).strict()),
      async (c) => {
        const { importDraftStore, importsEnabled, removeDraftPreview } = readState();
        if (!importsEnabled) return readOnly(c);
        try {
          await importDraftStore.delete(c.req.param('draftId'), c.req.valid('query').expectedRevision);
          removeDraftPreview(c.req.param('draftId'));
          return c.body(null, 204);
        } catch (error) {
          return draftError(c, error);
        }
      },
    )
    .put(
      '/api/import-drafts/:draftId/source',
      zValidator('query', z.object({ path: z.string().min(1).max(1_024) }).strict()),
      async (c) => {
        const { importDraftStore, importsEnabled } = readState();
        if (!importsEnabled) return readOnly(c);
        try {
          return c.json(await importDraftStore.writeUploadFile(c.req.param('draftId'), c.req.valid('query').path, c.req.raw.body, c.req.raw.signal));
        } catch (error) {
          return draftError(c, error);
        }
      },
    )
    .post('/api/import-drafts/:draftId/source/complete', zValidator('json', revisionSchema), async (c) => {
      const { importDraftStore, importsEnabled } = readState();
      if (!importsEnabled) return readOnly(c);
      try {
        return c.json({ draft: await importDraftStore.completeUpload(c.req.param('draftId'), c.req.valid('json').expectedRevision) });
      } catch (error) {
        return draftError(c, error);
      }
    })
    .post('/api/import-drafts/:draftId/parse', zValidator('json', revisionSchema), async (c) => {
      const { importDraftStore, importsEnabled } = readState();
      if (!importsEnabled) return readOnly(c);
      try {
        return c.json({ draft: await importDraftStore.parse(c.req.param('draftId'), c.req.valid('json').expectedRevision) });
      } catch (error) {
        return draftError(c, error);
      }
    })
    .patch('/api/import-drafts/:draftId/semantic-overlay', zValidator('json', semanticUpdateSchema), async (c) => {
      const { importDraftStore, importsEnabled } = readState();
      if (!importsEnabled) return readOnly(c);
      try {
        const { expectedRevision, nodeId, directive } = c.req.valid('json');
        return c.json(await importDraftStore.updateSemanticDirective(c.req.param('draftId'), expectedRevision, nodeId, directive));
      } catch (error) {
        return draftError(c, error);
      }
    })
    .post('/api/import-drafts/:draftId/plan', zValidator('json', planSchema), async (c) => {
      const { importDraftStore, importsEnabled } = readState();
      if (!importsEnabled) return readOnly(c);
      try {
        const { expectedRevision, rootIds } = c.req.valid('json');
        return c.json(await importDraftStore.plan(c.req.param('draftId'), expectedRevision, rootIds));
      } catch (error) {
        return draftError(c, error);
      }
    })
    .post('/api/import-drafts/:draftId/compile', zValidator('json', revisionSchema), async (c) => {
      const { importDraftStore, importsEnabled } = readState();
      if (!importsEnabled) return readOnly(c);
      try {
        return c.json({ draft: await importDraftStore.compile(c.req.param('draftId'), c.req.valid('json').expectedRevision) });
      } catch (error) {
        return draftError(c, error);
      }
    })
    .post(
      '/api/import-drafts/:draftId/visual-evidence',
      zValidator('query', z.object({ expectedRevision: z.coerce.number().int().positive() }).strict()),
      async (c) => {
        const { importDraftStore, importsEnabled } = readState();
        if (!importsEnabled) return readOnly(c);
        try {
          const form = await c.req.formData();
          if ([...form.keys()].length !== 4 || ['report', 'reference', 'capture', 'diff'].some((name) => form.getAll(name).length !== 1)) {
            throw new ImportDraftError('Visual evidence requires exactly one report, reference, capture and diff');
          }
          const reportValue = form.get('report');
          if (typeof reportValue !== 'string' || reportValue.length > 64 * 1024) throw new ImportDraftError('Visual evidence report is missing or too large');
          const files = await Promise.all((['reference', 'capture', 'diff'] as const).map(async (name) => {
            const value = form.get(name);
            if (!value || typeof value === 'string' || value.type !== 'image/png') {
              throw new ImportDraftError(`${name} must be a PNG file`);
            }
            if (value.size > MAX_VISUAL_EVIDENCE_BYTES) throw new ImportDraftError(`${name} PNG exceeds the 16 MiB limit`);
            return [name, new Uint8Array(await value.arrayBuffer())] as const;
          }));
          const draft = await importDraftStore.saveVisualEvidence(
            c.req.param('draftId'),
            c.req.valid('query').expectedRevision,
            visualEvidenceInputSchema.parse(JSON.parse(reportValue)),
            Object.fromEntries(files) as { reference: Uint8Array; capture: Uint8Array; diff: Uint8Array },
          );
          return c.json({ draft, visualEvidence: draft.visualEvidence }, 201);
        } catch (error) {
          return draftError(c, error);
        }
      },
    )
    .post('/api/import-drafts/:draftId/materialize', zValidator('json', materializeSchema), async (c) => {
      const { importDraftStore, importsEnabled } = readState();
      if (!importsEnabled) return readOnly(c);
      try {
        const { expectedRevision, targetPath } = c.req.valid('json');
        return c.json(await importDraftStore.materialize(c.req.param('draftId'), expectedRevision, targetPath));
      } catch (error) {
        return draftError(c, error);
      }
    });
}

function readOnly(c: { json: (value: { error: string }, status: 403) => Response }) {
  return c.json({ error: 'Design imports are unavailable in read-only view mode' }, 403);
}

function draftError(c: { json: (value: { error: string }, status: 400 | 404 | 408 | 409 | 413 | 503) => Response }, error: unknown) {
  return c.json(
    { error: error instanceof Error ? error.message : String(error) },
    error instanceof ImportDraftError || error instanceof UploadError ? error.status : 400,
  );
}
