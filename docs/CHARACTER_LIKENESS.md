# Character likeness - backend implementation, 2026-10-11

The character screen exposes paid likeness during onboarding. Wallet connection
establishes identity; it does not prove payment. The backend now implements private
photo ingestion, a durable generation pipeline, preview approval and private result
access. **Public uploads, generation and payments remain disabled.** Authorized
synthetic operator trials have now consumed **175 of 200 Tripo** credits. No real-person
photo, player-wallet charge or production deployment was performed.

API and worker composition now assemble configured private storage and a gated human
pipeline. Owned job listing, mesh preview, validated manifest, selection acceptance,
and `character.likenessJobId` persistence are implemented. New generation remains off.

The user approved **3 USDC per completed creation**. Dedicated unsigned checkout,
finalized transfer verification, interrupted-broadcast recovery and durable
`delivery_owed`/`manual_review` tracking are implemented. No live wallet transfer
has been performed. See the deployment handoff for exact routes and failure policy.
The corrected synthetic operator job passed actual Unity Humanoid/animation/world
factory/cache tests and was marked completed through trusted local validation. This
is one local synthetic artifact, not public model-quality approval.

The ten authored identities are whitelisted. Assassin, Hazmat and Balaclava have
covered faces and return `face_covered`. Snow, Rain and the two UBC humans use human
conditioning; Gynoid, Shark and Froggy use stylized conditioning. These are requested
transformations, not evidence of successful visual likeness or mesh preservation.

## HTTP contract

Every endpoint requires bearer authentication, including before character creation.
Every write requires a UUID `Idempotency-Key`.

| Endpoint                                        | Behavior                                                                                                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/likeness`                              | Availability, ten identities, consent version. Current response: `enabled:false`, `photoUploadEnabled:false`, `price:{amount:"3.00",currency:"USDC",display:"3.00 USDC"}`.          |
| `POST /v1/likeness/photos`                      | Binary PNG/JPEG, maximum 8 MiB; explicit version/own-photo/provider-sharing headers. Current composition returns 503 before buffering/decoding.                                     |
| `DELETE /v1/likeness/photos/{id}`               | Withdraw source consent, cancel active jobs and delete the owned source; deletion failures remain journaled.                                                                        |
| `POST /v1/likeness/jobs`                        | Strict `{modelId,uploadId,entitlementId,consent}` with version `likeness-v1` and both consent flags true. Dedicated verified entitlement required; current composition returns 503. |
| `GET /v1/likeness/jobs/{id}`                    | Owned status, phase, preview hash and sanitized failure reason; remains available while new generation is disabled.                                                                 |
| `GET /v1/likeness/jobs/{id}/reference`          | Owned conditioned JPEG with `Cache-Control: private, no-store` and `X-Content-Sha256`.                                                                                              |
| `POST /v1/likeness/jobs/{id}/reference/approve` | `{referenceSha256}` binds approval to the displayed image. Required before mesh generation.                                                                                         |
| `DELETE /v1/likeness/jobs/{id}`                 | Cancel further stages; preserve provider task IDs for reconciliation and queue private artifact cleanup.                                                                            |
| `GET /v1/likeness/jobs/{id}/result`             | Owned private GLB only after trusted runtime acceptance marks `completed/succeeded`. Configured human worker performs bounded validation; public composition remains disabled.      |

Photo consent headers are `X-Likeness-Consent-Version: likeness-v1`,
`X-Likeness-Own-Photo: true`, `X-Likeness-Share-With-Provider: true`. The versioned
consent UI must name Tripo and describe processor retention before activation.
No arbitrary image URL, client payment claim, user ID or provider API key is accepted.
There is no public entitlement-grant, operator-bypass or completion endpoint.

## Private ingestion and retention

Sharp 0.35.5 decodes real PNG/JPEG input with strict truncation checks, bounded
pixel/dimension/processing limits, orientation correction and metadata stripping.
Only a normalized JPEG (maximum 2048-pixel edge / 4 MiB) enters storage. Original
bytes are not retained. Animated/multipage inputs and MIME mismatches are rejected.

Photo sessions have durable request hashes, 90-second processing leases and a
24-hour retention deadline. One active photo per owner is enforced by a partial
unique index, including concurrent submissions. Retrying the same bytes after a
worker crash reuses the same object and upload ID; immutable writes are compared
by SHA-256 before accepting an already-stored object. A stale lease cannot finalize
or delete a recovered processing upload.

Storage adapters use opaque UUID object keys, bounded reads, immutable creation
and sanitized errors. Local storage is allowed only in development/test with
private directory/file permissions. Production requires a dedicated private S3
bucket with public access blocked and encryption provisioned; the ads bucket is
not reused. Public bucket provisioning and provider-side deletion are not done.

Withdrawal records deletion and cancels active jobs before object deletion. Cleanup
retries failed deletions and expires source photos. Pending job artifacts have the
same 24-hour deadline. Cancelled/failed artifacts are removed after any current
worker lease expires. Deleted source and artifact keys retain cleanup tombstones
that are checked again at a bounded five-minute cadence; a timed-out object-store
write that finishes after deletion remains eligible for another sweep. Dedicated
bucket lifecycle expiry is an additional production provisioning gate. Provider task IDs/payment proof metadata remain for billing
reconciliation; private provider upload tokens are cleared during artifact cleanup.
A request already sent to Tripo cannot be recalled by deleting our copy. No
unverified provider deletion SLA is promised.

## Durable paid stages

Postgres is the queue, with leased `FOR UPDATE SKIP LOCKED` claims. Each job has one
unique attempt per stage, an immutable selected model/reference revision, consent,
seed, task IDs and provider-reported consumed credits. The worker performs one
bounded stage per tick:

```text
source normalization/upload
  -> conditioned full-body reference
  -> awaiting_reference_approval
  -> owner approves exact preview hash
  -> image_to_model
  -> animate_prerigcheck (riggable + biped required)
  -> animate_rig
  -> bounded private GLB download and structural validation
  -> awaiting_asset_validation
```

A stage is durably reserved **before** its task POST. Lost responses, crashes while
submitting and unknown task states go to `reconciliation_required`. There is no
blind retry of a potentially paid POST. A returned task ID is retained even if
cancellation races the response. Failed jobs keep their consumed entitlement; a
replacement/refund policy must reconcile the existing payment and provider task,
not silently create another billed generation.

Permission is rechecked after private reads and before every new provider upload,
paid submission and artifact write. Authored-reference loading has a five-second
timeout. Per-job leases last 120 seconds. Read-only polling and source/token
preparation have bounded retry counts/backoff;
provider tasks have a 30-minute polling deadline. Terminal provider failures do not
resubmit. The scheduler runs serial bounded ticks and periodic private cleanup,
including cleanup while new generation is disabled. `buildWorkers` accepts an
explicitly assembled likeness runtime; the default composition supplies none.

## Artifact validation and delivery

The separate artifact reader accepts only exact configured output hosts. It rejects
credentials, redirects, private/reserved DNS answers, compressed/partial/empty
responses and oversized bodies. DNS resolution and streaming share a deadline;
resolved addresses are pinned for the request while preserving the TLS hostname.
Only test fixtures may use loopback HTTP.

The GLB inspector validates a deliberately limited self-contained GLB 2 subset:
binary ranges/alignment, finite vertex data, index bounds, weights/joints, scene
visibility, a common rig root, embedded PNG/JPEG signatures, at most 12,000 triangles
and 15–150 unique joints. Unsupported compression, sparse data, supplied animations,
morphs and extensions are rejected pending dedicated validators. Processing budgets
bound accessor and skinned-vertex inspection. The subsequent human validator fully
decodes embedded PNG/JPEG textures, limits edges to2048 and aggregate pixels to16M,
requires exact Mixamo bone names with valid torso/head/limb ancestry and upright
proportions, and limits delivered GLBs to16MiB. This is not a replacement for the
client's valid Humanoid Avatar and animation checks.

A structurally valid rig remains `processing/awaiting_asset_validation`. No client
can fetch it through the result endpoint until a separate trusted validator marks
it `succeeded/completed`. That server transition now exists behind the confirmed
runtime-profile configuration. Client acceptance selects an already validated result;
it cannot grant validation. No existing stock character asset is overwritten.

## Purchase and ownership boundaries

Migration `1700000075000_likeness_jobs.sql` adds dedicated verified entitlements,
private upload metadata and one-purchase/one-job records. Composite foreign keys
bind source and entitlement to the job owner. SERIALIZABLE transactions, unique
payment references and a unique entitlement on jobs handle concurrent retries.
The current cash-topup webhook grants game cash and is not used for likeness.

Migration `1700000076000_likeness_pipeline.sql` adds photo sessions, stage/lease/
artifact columns, provider attempts and durable action receipts. Approval, cancel
and deletion hashes include operation and resource identity; a key reused for a
different action is rejected. Matching writes replay safely beyond the generic
Redis response cache. No purchase-grant code was added. The separate operator trial
reads `TRIPO_API_KEY`; this does not activate the public service.

## Provider adapter and verified sources

The Tripo adapter uses server-side credentials, fixed production API host, bounded
HTTP/response parsing, validated task payloads and sanitized errors. It implements:

- Multipart `POST /upload`, following the current official SDK; validated bytes only.
  [SDK source](https://github.com/VAST-AI-Research/tripo-python-sdk/blob/master/tripo3d/client_impl/aiohttp_client_impl.py).
- `generate_image`, pinned `gemini_3.1_flash_image_preview`, two private image tokens
  for the authored body and consented face, versioned human/creature prompts.
  [Conditioning docs](https://docs.tripo3d.ai/image-generation/advanced-image-generation.html).
- `image_to_model`, pinned `v3.1-20260211`, PBR, deterministic seeds and 6,000-face target.
  [H3 docs](https://docs.tripo3d.ai/model-generation/image-to-model-v3-0-v3-1.html).
- `animate_prerigcheck`, then `animate_rig` pinned `v2.5-20260210`, biped Tripo GLB.
  [Pre-rig docs](https://docs.tripo3d.ai/animation/pre-rig-check-v2-0-20250506.html),
  [rig docs](https://docs.tripo3d.ai/animation/rig-v2-5-20260210.html).
- `GET /task/{id}`, validated matching task ID and all documented terminal states.
  [Task docs](https://docs.tripo3d.ai/task-query/get-your-task-result.html).

The adapter distinguishes a confirmed end-user integration agreement from a separate,
explicitly authorized operator-only evaluation. Operator evaluation does not enable
public routes, upload collection or charging. An operator-only evaluation was later
authorized on 2026-10-11 with a strict **200 Tripo API credit** campaign cap. Its
durable ledger and artifacts live outside the repository; credentials never belong
in the evidence. The public integration agreement and product gates remain unmet.

`tools/scripts/likeness-trial.ts` stages the evaluation explicitly: source upload,
conditioned reference, visual approval by image hash, mesh, pre-rig check and rig.
Every potentially paid POST is preceded by a flushed credit reservation. Unknown
submission outcomes block further spending pending reconciliation; the tool never
automatically resubmits. Per-stage ceilings are 10/50/0/25 credits, conservatively
85 for the first complete trial. A larger account balance does not raise the cap.
Only owned stock references and a generated fictional adult portrait are inputs.
This experiment generates a replacement mesh; it does not establish face-only
editing or preservation of the authored mesh, topology or animation rig.

## Remaining external and runtime gates

1. For public users: written Tripo end-user integration authorization, named-processor
   consent/retention/deletion arrangements, dedicated private storage/lifecycle expiry
   and secrets.
2. Server-priced checkout with verified fulfillment into the dedicated entitlement:
   recipient, mint, amount, network and finality/unique proof. Confirm distribution
   policy; implement explicit failure/reconciliation/refund handling.
3. Render and version the actual full-body reference for every enabled authored model.
   Evaluate human and creature likeness/body preservation using an approved budget
   and consented test inputs. Prompt/API availability does not prove quality.
4. Provision exact provider output-host allowlists from verified live responses;
   activate the configured scheduler and monitored retention sweep.
5. Complete texture/material/mobile budgets, skeleton/animation validation and private
   Unity runtime loading/equipping. Add the trusted acceptance transition only after
   those checks are implemented. Until then, no playable-result claim or sale.

## Local verification

Tests exercise real isolated Postgres schemas, Sharp, private disk/S3 adapters and
loopback HTTP/UDP fixtures. Inputs are synthetic pixels and a synthetic rig. They
cover ownership, concurrency, replay, expired/deleted photos, crash recovery,
uncertain paid submissions, cancellation, approval, bounded retries and malformed
artifacts. They do not demonstrate live likeness, exact source-mesh preservation,
actual provider pricing/credits or in-game animation quality.

Migration 074 (now 076, likeness_pipeline) was the sole pending migration and was applied only to the verified
loopback database. Port4010 restarted with the existing entrypoint/environment,
PID-file and log conventions. Live HTTP: anonymous availability401; authenticated
availability200 (all ten identities, uploads/generation/pricing disabled); unknown
owned job404; photo upload and valid generation both503. Checks used a synthetic
test identity and non-image bytes, not a real photo or player wallet.

No staging/production service, user wallet or existing character was changed.

Final local checks: **184 targeted tests passed**, repository typecheck, changed-file
ESLint, formatting/diff checks, contract generation and architecture layering check
passed. The docs checker still fails on 28 pre-existing README environment-variable
coverage omissions and three broken vendored handoff links. Existing Fastify and
OpenAPI documentation renderer deprecation warnings remain. Production upload
rate/capacity limits and retention monitoring must
also be set before enabling customer traffic.

The subsequent operator ledger/adapter changes passed 33 focused tests, typecheck
and targeted ESLint. Live evaluation outcomes are recorded separately from these
fixture checks; neither success nor playable quality is implied by passing tests.

The first authorized real operator trial completed image conditioning, H3 mesh,
pre-rig check and rig for **75 API credits**. Its GLB passes structural inspection
(8,286 triangles, 52 joints; 3,575,620 bytes) and imports into Blender 5.1.2. Visual
inspection found face, hair and body-proportion drift; it is not accepted as a
production personalization result. No Unity animation/runtime test was performed.
The externally stored trial README, raw GLB and labeled material/diffuse renders
record the evidence; the public service remains disabled. A separately authorized
Froggy comparison also completed for 75 credits using the actual stock frog render
and same fictional face. It preserves recognizable frog anatomy and hair/beard
cues but invents a necklace, reconstructs geometry and produces overly shiny PBR
materials. It is not accepted for production. Both complete trials consumed **150
of the authorized 200 credits**; final available balance 350, frozen 0. No further
paid task was submitted. The raw Froggy GLB has 7,654 triangles and 52 joints and
also imported into Blender; neither result was imported into Unity.

Final combined regression after adding palette validation: **247 tests passed in
12 files**, covering the full likeness suite, provider adapter, operator ledger,
palette HTTP/domain and existing auth signatures. Real character creation and
persistence pass for all 32 existing authored submissions. Typecheck, targeted
ESLint, contract generation/checks, formatting/diff and layering checks pass. The
pre-existing docs-check failures remain as noted above. No additional credits were
spent during these fixture tests.
