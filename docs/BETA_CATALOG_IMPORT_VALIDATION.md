# Exact-digest beta.4 catalog validation

This procedure supplies the mandatory catalog row in the [beta.4 replacement profile](BETA_RELEASE_CRITERIA.md#approved-beta4-replacement-release-profile). Run it from the clean, frozen candidate checkout, against its published immutable digest, after the existing [candidate identity and supply-chain gates](RELEASE.md#original-comprehensive-two-stage-beta-promotion) pass. An unpublished image, earlier source benchmark or another digest cannot pass this row.

Use a native Linux `amd64` host, Node 24, Bash, GNU `timeout`, Docker with Buildx, `jq`, `openssl` and `sha256sum`. Use a local Unix-socket Docker daemon with at least 4 GiB free memory and disk. The workload has two CPUs, two GiB RAM, no usable swap and a 900-second cap. Do not bind existing application data, use integration credentials or modify another container. Host network access is limited to the immutable image pull and registry manifest reads; all application/import/check containers have `--network none` and no published ports. This is a fresh catalog test, not a production data migration or a responsiveness benchmark.

Copy the Bash blocks below, in order, into one temporary script outside the checkout. Fill the five candidate/asset inputs from reviewed release evidence, then run it with Bash; do not source it. Keep the checkout clean. A nonzero command, timeout, failed assertion or incomplete cleanup is a failed run. Do not rerun individual phases against a partially used volume.

## Identity and owned resources

```bash
set -euo pipefail
umask 077
CAT_REVISION='<full frozen main SHA>'
CAT_DIGEST='sha256:<validated OCI index digest>'
CAT_PLATFORM='sha256:<validated linux/amd64 manifest digest>'
CAT_IMAGE_ID='sha256:<validated image config digest>'
CAT_ASSET='/absolute/path/to/moodarr-wikidata-20260622-min5-v1.jsonl.gz'
CAT_IMAGE="ghcr.io/jremick/moodarr@$CAT_DIGEST"
CAT_ASSET_HASH=dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a
test "$(git rev-parse HEAD)" = "$CAT_REVISION"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
test "$(uname -sm)" = 'Linux x86_64'
CAT_ENDPOINT="${DOCKER_HOST:-$(docker context inspect --format '{{(index .Endpoints "docker").Host}}')}"
case "$CAT_ENDPOINT" in unix://*) ;; *) exit 1 ;; esac
docker_catalog() { timeout --kill-after=5 30 docker --host "$CAT_ENDPOINT" "$@"; }
test "$(docker_catalog info --format '{{.OSType}}/{{.Architecture}}')" = linux/x86_64
test "$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)" = 0
test "$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)" -ge 4194304
test "$(df -Pk "$(docker_catalog info --format '{{.DockerRootDir}}')" | awk 'NR==2 {print $4}')" -ge 4194304
CAT_DIR="$(mktemp -d)"
mkdir "$CAT_DIR/public"
chmod 755 "$CAT_DIR/public"
CAT_OWNER="$(openssl rand -hex 16)"
CAT_LABEL=io.moodarr.catalog-validation.owner
CAT_VOLUME="moodarr-catalog-$CAT_OWNER"
CAT_NAMES=("$CAT_VOLUME-import" "$CAT_VOLUME-before" "$CAT_VOLUME-app" "$CAT_VOLUME-after")
CAT_APP="${CAT_NAMES[2]}"
resource_state() {
  local kind="$1" name="$2" listed
  if test "$kind" = container; then
    listed="$(docker_catalog container ls -a --filter "name=^${name}$" --format '{{.Names}}')" || return 1
  else listed="$(docker_catalog volume ls --filter "name=^${name}$" --format '{{.Name}}')" || return 1; fi
  if test -z "$listed"; then printf absent
  elif test "$listed" = "$name"; then printf present
  else return 1; fi
}
owned_volume() {
  docker_catalog volume inspect "$CAT_VOLUME" | jq -e --arg n "$CAT_VOLUME" --arg k "$CAT_LABEL" --arg o "$CAT_OWNER" \
    'length==1 and .[0].Name==$n and .[0].Labels[$k]==$o and .[0].Driver=="local" and (.[0].Options==null or .[0].Options=={})' >/dev/null
}
cleanup() {
  local result=$? failed=0 name state metadata remaining
  trap - EXIT INT TERM HUP
  for name in "${CAT_NAMES[@]}"; do
    if ! state="$(resource_state container "$name")"; then failed=1; continue; fi
    test "$state" != absent || continue
    if ! metadata="$(docker_catalog inspect "$name")"; then failed=1; continue; fi
    if ! jq -e --arg n "/$name" --arg k "$CAT_LABEL" --arg o "$CAT_OWNER" \
      'length==1 and .[0].Name==$n and .[0].Config.Labels[$k]==$o' <<< "$metadata" >/dev/null; then failed=1; continue; fi
    docker_catalog rm -f "$name" >/dev/null || failed=1
  done
  if state="$(resource_state volume "$CAT_VOLUME")"; then
    if test "$state" = present; then
      if owned_volume; then docker_catalog volume rm "$CAT_VOLUME" >/dev/null || failed=1; else failed=1; fi
    fi
  else failed=1; fi
  if remaining="$(docker_catalog container ls -aq --filter "label=$CAT_LABEL=$CAT_OWNER")"; then test -z "$remaining" || failed=1; else failed=1; fi
  if remaining="$(docker_catalog volume ls -q --filter "label=$CAT_LABEL=$CAT_OWNER")"; then test -z "$remaining" || failed=1; else failed=1; fi
  rm -f -- "$CAT_DIR/app.env"
  jq -n --argjson failed "$failed" '{ownedResourcesRemoved:($failed==0),credentialFileRemoved:true}' > "$CAT_DIR/cleanup.json"
  test "$failed" = 0 || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 124' INT TERM HUP
test "$(resource_state volume "$CAT_VOLUME")" = absent
for name in "${CAT_NAMES[@]}"; do test "$(resource_state container "$name")" = absent; done
timeout --kill-after=5 300 docker --host "$CAT_ENDPOINT" pull --platform linux/amd64 "$CAT_IMAGE" > "$CAT_DIR/pull.log"
docker_catalog buildx imagetools inspect "$CAT_IMAGE" --raw > "$CAT_DIR/index.json"
test "sha256:$(sha256sum "$CAT_DIR/index.json" | cut -d' ' -f1)" = "$CAT_DIGEST"
jq -e --arg p "$CAT_PLATFORM" '[.manifests[] | select(.platform.os=="linux" and .platform.architecture=="amd64")] | length==1 and .[0].digest==$p' "$CAT_DIR/index.json" >/dev/null
docker_catalog buildx imagetools inspect "ghcr.io/jremick/moodarr@$CAT_PLATFORM" --raw > "$CAT_DIR/platform.json"
test "sha256:$(sha256sum "$CAT_DIR/platform.json" | cut -d' ' -f1)" = "$CAT_PLATFORM"
jq -e --arg id "$CAT_IMAGE_ID" '.config.digest==$id' "$CAT_DIR/platform.json" >/dev/null
docker_catalog image inspect "$CAT_IMAGE" | jq -e --arg id "$CAT_IMAGE_ID" --arg r "$CAT_REVISION" --arg image "$CAT_IMAGE" '.[0] |
  .Id==$id and (.RepoDigests|index($image)!=null) and .Os=="linux" and .Architecture=="amd64" and .Config.User=="999:999" and
  .Config.Labels["org.opencontainers.image.revision"]==$r and .Config.Labels["org.opencontainers.image.version"]=="0.1.0-beta.4" and
  .Config.Labels["io.moodarr.ai-provider-policy"]=="none" and .Config.Labels["io.moodarr.tmdb-content-policy"]=="none"' > "$CAT_DIR/image-check.json"
cp scripts/validation/beta-catalog-check.ts "$CAT_DIR/public/check.ts"
cp "$CAT_ASSET" "$CAT_DIR/public/catalog.jsonl.gz"
test "$(sha256sum "$CAT_DIR/public/catalog.jsonl.gz" | cut -d' ' -f1)" = "$CAT_ASSET_HASH"
npm run --silent validate:beta-catalog-asset -- --file "$CAT_DIR/public/catalog.jsonl.gz" > "$CAT_DIR/asset-validation.json"
jq -n --arg revision "$CAT_REVISION" --arg digest "$CAT_DIGEST" --arg imageId "$CAT_IMAGE_ID" --arg assetSha256 "$CAT_ASSET_HASH" \
  '{version:"0.1.0-beta.4",revision:$revision,digest:$digest,imageId:$imageId,assetSha256:$assetSha256,assetRecords:90397}' > "$CAT_DIR/public/manifest.json"
chmod 644 "$CAT_DIR/public/"*
docker_catalog volume create --label "$CAT_LABEL=$CAT_OWNER" "$CAT_VOLUME" >/dev/null
owned_volume
cat > "$CAT_DIR/app.env" <<'ENV'
NODE_ENV=production
MOODARR_API_HOST=127.0.0.1
MOODARR_API_PORT=4401
MOODARR_WEB_ORIGIN=http://127.0.0.1:4401
MOODARR_DATA_DIR=/data
MOODARR_DB_PATH=/data/moodarr.sqlite
MOODARR_CONFIG_PATH=/data/config.json
MOODARR_FIXTURE_MODE=false
MOODARR_REQUIRE_ADMIN_TOKEN=true
MOODARR_ADMIN_AUTO_SESSION=false
MOODARR_PLEX_AUTH_ENABLED=false
MOODARR_SYNC_INTERVAL_MINUTES=0
MOODARR_SYNC_SEERR=false
AI_PROVIDER=none
MOODARR_TMDB_CONTENT_POLICY=none
PLEX_BASE_URL=
PLEX_TOKEN=
SEERR_BASE_URL=
SEERR_API_KEY=
OPENAI_API_KEY=
ENV
printf 'MOODARR_ADMIN_TOKEN=%s\n' "$(openssl rand -hex 32)" >> "$CAT_DIR/app.env"
CAT_COMMON=(--platform linux/amd64 --network none --read-only --init --user 999:999 --cap-drop ALL
  --security-opt no-new-privileges:true --pids-limit 128 --cpus 2 --memory 2g --memory-swap 2g --restart no
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777 --label "$CAT_LABEL=$CAT_OWNER" --env-file "$CAT_DIR/app.env"
  --mount "type=volume,src=$CAT_VOLUME,dst=/data" --mount "type=bind,src=$CAT_DIR/public,dst=/checks,readonly")
CAT_DEADLINE=$((SECONDS+900))
bounded_docker() { local remaining=$((CAT_DEADLINE-SECONDS)); test "$remaining" -gt 0; timeout --foreground --kill-after=5 "$remaining" docker --host "$CAT_ENDPOINT" "$@"; }
controls() {
  owned_volume
  test "$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)" = 0
  docker_catalog inspect "$1" | jq -e --arg image "$CAT_IMAGE_ID" --arg ref "$CAT_IMAGE" --arg k "$CAT_LABEL" --arg o "$CAT_OWNER" --arg v "$CAT_VOLUME" \
    --arg root "$CAT_DIR/public" --argjson swapLimit "$(docker_catalog info --format '{{.SwapLimit}}')" '.[0] |
    .Image==$image and .Config.Image==$ref and .Config.User=="999:999" and .Config.Labels[$k]==$o and
    .HostConfig.NetworkMode=="none" and .HostConfig.ReadonlyRootfs and .HostConfig.Init and .HostConfig.CapDrop==["ALL"] and
    .HostConfig.SecurityOpt==["no-new-privileges:true"] and .HostConfig.PidsLimit==128 and .HostConfig.NanoCpus==2000000000 and
    .HostConfig.Memory==2147483648 and (.HostConfig.MemorySwap==2147483648 or (.HostConfig.MemorySwap == -1 and $swapLimit==false)) and
    (.HostConfig.OomKillDisable==null or .HostConfig.OomKillDisable==false) and .HostConfig.RestartPolicy.Name=="no" and
    (.HostConfig.PortBindings==null or .HostConfig.PortBindings=={}) and .HostConfig.Tmpfs["/tmp"]=="rw,nosuid,nodev,noexec,size=512m,mode=1777" and
    ([.Mounts[]|select(.Destination=="/data" and .Type=="volume" and .Name==$v and .RW)]|length)==1 and
    all(.Mounts[]; .Destination=="/data" or (.Destination=="/checks" and .Type=="bind" and .Source==$root and .RW==false))' >/dev/null
  docker_catalog inspect "$1" | jq '.[0] | {imageId:.Image,image:.Config.Image,user:.Config.User,network:.HostConfig.NetworkMode,
    memoryBytes:.HostConfig.Memory,memorySwap:.HostConfig.MemorySwap,nanoCpus:.HostConfig.NanoCpus,pids:.HostConfig.PidsLimit,
    readonlyRoot:.HostConfig.ReadonlyRootfs,init:.HostConfig.Init,capDrop:.HostConfig.CapDrop,securityOpt:.HostConfig.SecurityOpt,
    tmpfs:.HostConfig.Tmpfs,restartPolicy:.HostConfig.RestartPolicy.Name}' > "$CAT_DIR/$1-controls.json"
}
```

The manifest, platform and image-config identities must also match the independently reviewed attestation and candidate-workflow reports. Hash comparison alone is not signature verification. Retain those references and the successful public asset-validation report; do not replace either with this script's identity assertions. Docker may normalize `MemorySwap` to `-1` only when swap-limit support is false and the host has zero usable swap throughout.

## Import, cold integrity and restart

```bash
docker_catalog create --name "${CAT_NAMES[0]}" "${CAT_COMMON[@]}" --no-healthcheck "$CAT_IMAGE" dist/server/importWikidataCatalog.js \
  --file /checks/catalog.jsonl.gz --source wikidata --version wikidata-20260622-min5-v1 --mode full-snapshot \
  --expected-source-records 90397 --expected-file-sha256 "$CAT_ASSET_HASH" --batch-size 1000 >/dev/null
controls "${CAT_NAMES[0]}"
bounded_docker start -a "${CAT_NAMES[0]}" > "$CAT_DIR/import.json" 2> "$CAT_DIR/import.stderr.log"
jq -e --arg hash "$CAT_ASSET_HASH" '.source=="wikidata" and .sourceVersion=="wikidata-20260622-min5-v1" and .mode=="full_snapshot" and
  .records==90397 and .imported==90397 and .skipped==0 and .sourceRecordsUpserted==90397 and .uniqueImportableSourceRecords==90397 and
  .expectedSourceRecords==90397 and .expectedFileSha256==$hash and .fileSha256==$hash and .dryRun==false and .rehydrateRequired==false and .limit==null and
  .refreshRequiredRemaining==0 and .refreshRequiredSourceRecordsRemaining==0 and .typeRepairSourceRecordsRemaining==0 and
  .typeRepairAffectedBindingsRemaining==0 and .typeRepairDerivedItemsRemaining==0 and .recoveryDerivedItemsRemaining==0 and .recoverySourceRecordsRemaining==0' "$CAT_DIR/import.json" >/dev/null
test "$(sha256sum "$CAT_DIR/public/catalog.jsonl.gz" | cut -d' ' -f1)" = "$CAT_ASSET_HASH"
cat > "$CAT_DIR/public/cold.mjs" <<'JS'
import { DatabaseSync } from 'node:sqlite';
// FTS5 requires its maintenance INSERT syntax. Roll back even if it fails; retain no data change.
const db=new DatabaseSync('/data/moodarr.sqlite');
try { db.exec('BEGIN');
  db.exec("INSERT INTO media_feature_fts(media_feature_fts) VALUES('integrity-check')");
  db.exec("INSERT INTO catalog_search_index_fts(catalog_search_index_fts) VALUES('integrity-check')");
} finally { try { db.exec('ROLLBACK'); } finally { db.close(); } }
process.argv=['node','/checks/check.ts','/checks/manifest.json','/data/moodarr.sqlite',...process.argv.slice(2)];
await import('/checks/check.ts');
JS
chmod 644 "$CAT_DIR/public/cold.mjs"
docker_catalog create --name "${CAT_NAMES[1]}" "${CAT_COMMON[@]}" --no-healthcheck "$CAT_IMAGE" /checks/cold.mjs >/dev/null
controls "${CAT_NAMES[1]}"
bounded_docker start -a "${CAT_NAMES[1]}" > "$CAT_DIR/public/before.json"
chmod 644 "$CAT_DIR/public/before.json"
docker_catalog create --name "$CAT_APP" "${CAT_COMMON[@]}" "$CAT_IMAGE" >/dev/null
controls "$CAT_APP"
bounded_docker start "$CAT_APP" >/dev/null
cat > "$CAT_DIR/public/ready.mjs" <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const m=JSON.parse(readFileSync('/checks/manifest.json','utf8'));
const get=async(path,status=200)=>{const r=await fetch('http://127.0.0.1:4401'+path,{redirect:'error',signal:AbortSignal.timeout(10000),headers:{Cookie:'moodarr_admin_locked=1'}});assert.equal(r.status,status);assert.ok(!r.headers.has('set-cookie'));return r;};
let h; const end=Date.now()+120000;
while(Date.now()<end){try{h=await(await get('/api/health')).json();if(h.ready)break;}catch{}await new Promise(r=>setTimeout(r,500));}
assert.ok(h?.ok&&h.ready&&h.database==='ok');assert.equal(h.version,m.version);assert.equal(h.revision,m.revision);assert.equal(h.fixtureMode,false);
assert.deepEqual(h.policies,{aiProvider:'none',tmdbContent:'none'});
assert.ok(h.search?.ready&&h.search.workerCount===2&&!h.search.closed);assert.ok(h.sync?.ready&&h.sync.workerCount===1&&!h.sync.closed&&!h.sync.running);
const c=await(await get('/api/config/status')).json();assert.ok(!c.plex.configured&&!c.seerr.configured&&!c.auth.plexAuthEnabled);
assert.deepEqual(c.admin,{authRequired:true,configured:true,autoSession:false});assert.equal(c.runtime.syncIntervalMinutes,0);assert.equal(c.runtime.syncSeerr,false);
await get('/api/admin/settings',401);
console.log(JSON.stringify({ok:true,candidate:m,ready:true,policies:h.policies,integrationsConfigured:false,anonymousAdminRejected:true}));
JS
chmod 644 "$CAT_DIR/public/ready.mjs"
bounded_docker exec "$CAT_APP" /nodejs/bin/node /checks/ready.mjs > "$CAT_DIR/runtime-before.json"
bounded_docker restart -t 30 "$CAT_APP" >/dev/null
bounded_docker exec "$CAT_APP" /nodejs/bin/node /checks/ready.mjs > "$CAT_DIR/runtime-after.json"
until test "$(docker_catalog inspect --format '{{.State.Health.Status}}' "$CAT_APP")" = healthy; do test "$SECONDS" -lt "$CAT_DEADLINE"; sleep 1; done
```

The [read-only checker](../scripts/validation/beta-catalog-check.ts) runs SQLite integrity/FK checks, exact source/run/provenance counts, derived-table and FTS membership, duplicate/orphan detection, FTS content equality and real `MATCH` queries. It hashes each row as UTF-8 `JSON.stringify(row) + "\n"` in the listed primary-key order. The 14 raw table hashes, score-coverage counts and all 13 semantic projection fields are retained. Missing deterministic scores are accepted only when all three mood/tone/watchability arrays are empty. Score ranges and source versions remain checked. The FTS5 postings check above is separate and transactional.

## API request-attempt isolation

Use only the generated disposable Admin token. These probes disable AI and cannot reach external services. Search and preview can create local diagnostics/audit rows. Exactly three preview audits are expected; no valid create confirmation is sent. The deliberately invalid ambiguous create must fail before a request operation exists.

```bash
cat > "$CAT_DIR/public/boundaries.mjs" <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const manifest=JSON.parse(readFileSync('/checks/manifest.json','utf8'));
const candidate=Object.fromEntries(['version','revision','digest','imageId'].map(k=>[k,manifest[k]]));
const token=process.env.MOODARR_ADMIN_TOKEN;assert.match(token,/^[a-f0-9]{64}$/);
for(const k of ['PLEX_BASE_URL','PLEX_TOKEN','SEERR_BASE_URL','SEERR_API_KEY','OPENAI_API_KEY'])assert.ok(!process.env[k]);
const db=new DatabaseSync('/data/moodarr.sqlite',{readOnly:true});
try {
const eligible=`SELECT m.id,m.title,m.media_type AS mediaType,CAST(e.value AS INTEGER) AS tmdbId
 FROM media_items m JOIN external_ids e ON e.media_item_id=m.id AND e.source='tmdb' AND e.media_type=m.media_type
 JOIN catalog_search_index x ON x.media_item_id=m.id WHERE m.source='catalog' AND length(trim(m.summary))>0 AND CAST(e.value AS INTEGER)>0
 AND EXISTS(SELECT 1 FROM genres g WHERE g.media_item_id=m.id)
 AND (SELECT COUNT(*) FROM catalog_source_records r WHERE r.media_item_id=m.id AND r.active=1 AND r.materialization_stale=0)=1
 AND EXISTS(SELECT 1 FROM catalog_source_records r WHERE r.media_item_id=m.id AND r.active=1 AND r.materialization_stale=0
 AND lower(r.license_policy) IN ('wikidata-cc0','cc0-1.0','operator-approved') AND (r.expires_at IS NULL OR julianday(r.expires_at)>julianday('now')))
 AND NOT EXISTS(SELECT 1 FROM external_ids d WHERE d.media_item_id=m.id AND d.source IN ('wikidata','imdb','tmdb','tvdb') AND d.media_type=m.media_type GROUP BY d.source HAVING COUNT(DISTINCT d.value)>1)
 AND NOT EXISTS(SELECT 1 FROM media_identity_quarantine q WHERE q.media_item_id=m.id)
 AND NOT EXISTS(SELECT 1 FROM plex_items p WHERE p.media_item_id=m.id) AND NOT EXISTS(SELECT 1 FROM seerr_items s WHERE s.media_item_id=m.id)`;
assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM (${eligible})`).get().n,82865);
async function post(path,body,status=200){const r=await fetch('http://127.0.0.1:4401'+path,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
 headers:{'Content-Type':'application/json','X-Moodarr-Admin-Token':token,Cookie:'moodarr_admin_locked=1','Idempotency-Key':'catalog-isolation-rejection'},body:JSON.stringify(body)});
 assert.equal(r.status,status);assert.ok(!r.headers.has('set-cookie'));return r.json();}
const search=(query,filters)=>post('/api/search',{query,filters,useAi:false,resultLimit:200,watchContext:'solo'});
const rows=body=>{assert.equal(body.usedAi,false);assert.ok(Array.isArray(body.results));return body.results;};
const selected={};let searchCalls=0;
for(const type of ['movie','tv']){
 const targets=db.prepare(`${eligible} AND m.media_type=? AND length(m.title) BETWEEN 12 AND 100 AND m.title NOT GLOB '*[^A-Za-z0-9 ,:!-]*' ORDER BY x.rank_score DESC,m.title,m.id LIMIT 5`).all(type);
 for(const target of targets){
  const ordinary=rows(await search(target.title,{mediaTypes:[type]}));
  const verified=rows(await search('I want to request '+target.title,{mediaTypes:[type],availability:['not_in_plex_requestable']}));
  const attempts=rows(await search('I want to request '+target.title,{mediaTypes:[type]}));searchCalls+=3;
  for(const result of [ordinary,verified])assert.ok(!result.some(r=>r.id===target.id||r.requestAttempt?.available));
  assert.ok(verified.every(r=>r.availabilityGroup==='not_in_plex_requestable'));
  const item=attempts.find(r=>r.id===target.id);if(!item)continue;
  assert.equal(item.availabilityGroup,'unavailable');assert.deepEqual(item.requestAttempt,{available:true,seerrAvailabilityChecked:false});
  assert.equal(item.metadata?.source,'catalog');assert.equal(item.plex?.available??false,false);assert.equal(item.seerr?.requestable??false,false);selected[type]=target;break;
 }assert.ok(selected[type],'No controlled '+type+' target surfaced');
}
const expectedAudits=[];
for(const [target,seasons,allowed] of [[selected.movie,undefined,true],[selected.tv,undefined,false],[selected.tv,[1],true]]){
 const b=await post('/api/requests/preview',{itemId:target.id,...(seasons?{seasons}:{})},allowed?200:409);
 assert.equal(b.canRequest,allowed);assert.equal(b.requestMode,'attempt');assert.equal(b.seerrAvailabilityChecked,false);assert.equal(b.requiresConfirmation,true);
 assert.equal(b.item.id,target.id);assert.equal(b.item.availabilityGroup,'unavailable');assert.deepEqual(b.item.requestAttempt,{available:true,seerrAvailabilityChecked:false});
 assert.equal(b.request.mediaType,target.mediaType);assert.equal(b.request.mediaId,target.tmdbId);assert.equal(b.request.title,target.title);assert.deepEqual(b.request.seasons,seasons);
 assert.equal(b.confirmationPhrase,'REQUEST '+target.title.toUpperCase());assert.match(b.confirmationToken,/^[a-f0-9]{64}$/);if(!allowed)assert.match(b.blockedReason,/season/i);
 expectedAudits.push({itemId:target.id,action:'preview',status:allowed?'allowed':'blocked',mediaType:target.mediaType,mediaId:target.tmdbId,seasonsJson:seasons?JSON.stringify(seasons):null,externalRequestId:null});
}
const ambiguous=db.prepare(`SELECT m.id,m.title,m.media_type AS mediaType FROM media_items m JOIN catalog_source_records r ON r.media_item_id=m.id AND r.active=1 AND r.materialization_stale=0
 WHERE m.source='catalog' GROUP BY m.id HAVING COUNT(DISTINCT r.source||char(31)||r.source_item_id)>1 ORDER BY length(m.title) DESC,m.id LIMIT 1`).get();assert.ok(ambiguous);
for(const [query,filters] of [[ambiguous.title,{}],['I want to request '+ambiguous.title,{availability:['not_in_plex_requestable']}],['I want to request '+ambiguous.title,{}]]){
 assert.ok(!rows(await search(query,filters)).some(r=>r.id===ambiguous.id));searchCalls++;
}
for(const path of ['/api/requests/preview','/api/requests/create']){
 const b=await post(path,{itemId:ambiguous.id,mediaType:ambiguous.mediaType,confirmed:true,confirmationPhrase:'CONTROLLED AMBIGUOUS REJECTION'},400);assert.match(b.error,/ambiguous catalog identity/);
}
for(const table of ['requests','request_creation_operations','plex_items','seerr_items','app_users','user_sessions'])assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0);
assert.deepEqual(db.prepare(`SELECT media_item_id AS itemId,action,status,media_type AS mediaType,media_id AS mediaId,seasons_json AS seasonsJson,external_request_id AS externalRequestId FROM request_audit ORDER BY id`).all().map(r=>({...r})),expectedAudits);
console.log(JSON.stringify({ok:true,candidate,searchCalls,eligibleCount:82865,genericIsolation:true,verifiedIsolation:true,explicitAttemptUnavailable:true,ambiguousRejected:true,
 previewContract:true,tvSeasonRequired:true,requests:0,requestCreationOperations:0,expectedAudits,renderedDisclosureVerified:false}));
} finally {db.close();}
JS
chmod 644 "$CAT_DIR/public/boundaries.mjs"
bounded_docker exec "$CAT_APP" /nodejs/bin/node /checks/boundaries.mjs > "$CAT_DIR/public/boundaries.json"
chmod 644 "$CAT_DIR/public/boundaries.json"
docker_catalog inspect "$CAT_APP" | jq -e '.[0] | .State.Running and .State.Health.Status=="healthy" and .State.OOMKilled==false and .RestartCount==0' > "$CAT_DIR/healthy.json"
bounded_docker stop -t 30 "$CAT_APP" >/dev/null
docker_catalog create --name "${CAT_NAMES[3]}" "${CAT_COMMON[@]}" --no-healthcheck "$CAT_IMAGE" /checks/cold.mjs /checks/before.json /checks/boundaries.json >/dev/null
controls "${CAT_NAMES[3]}"
bounded_docker start -a "${CAT_NAMES[3]}" > "$CAT_DIR/after.json"
jq -e '.restartContentParity==true' "$CAT_DIR/after.json" >/dev/null
for name in "${CAT_NAMES[@]}"; do
  controls "$name"
  docker_catalog inspect "$name" | jq -e '.[0] | .State.Running==false and .State.ExitCode==0 and .State.OOMKilled==false and .RestartCount==0' >/dev/null
done
test "$SECONDS" -lt "$CAT_DEADLINE"
jq -n --argjson seconds "$((SECONDS-CAT_DEADLINE+900))" '{workloadSeconds:$seconds,workloadCapSeconds:900}' > "$CAT_DIR/timing.json"
printf 'Review the retained evidence directory before publishing any artifact.\n'
exit 0
```

Cleanup runs on success and failure. It refuses an unknown resource owner; Docker listing/inspection errors are failures, not proof of absence. A failed cleanup requires investigation and blocks this row. Do not use broad prune commands. Keep the shared candidate image. Remove only this run's temporary staging after reviewed artifacts are retained; no existing application data is touched.

## Acceptance and retained evidence

Require successful import and all checker/API assertions, healthy startup and one restart, no OOM/automatic restart, final post-stop integrity and content parity, and successful owned cleanup. Compare the other 13 raw table hashes exactly. For `catalog_search_index`, compare all 13 semantic fields; retain its raw hash and `projectionUpdatedAtChanges`. Only `updated_at` may differ. Do not equate missing deterministic scores, missing fingerprint scores and timestamp changes; do not hardcode an observed count as an exception.

Create a privacy-reviewed summary after the script exits. This is a maintainer-reviewed operator attestation, not an additional automated release validator. Use `Pending` until all required checks and cleanup pass; use `Failed` for a failed observation.

| Field | Required value or content |
| --- | --- |
| `schema`, `status`, `observedAt`, `reviewedBy` | `moodarr-beta4-catalog-validation-v1`; `Pending`, `Passed` or `Failed`; UTC time; reviewer and review time |
| `candidate` | Version, full revision, immutable OCI index digest, native platform digest and image/config ID; match the release ledger and attestation |
| `inputs` | Asset SHA-256 above, 90,397 source records, 82,865 eligible records; hashes of asset-validation, attestation and candidate-validation reports; checker/script SHA-256 and frozen source revision |
| `environment` | Native host/Docker architecture and versions, CPUs `2`, memory bytes `2147483648`, observed swap controls, zero host swap, network `none`, no published ports, resource-control check and measured duration below 900 seconds |
| `checks` | Boolean exact identity, full atomic import, final file hash, SQLite/FK/FTS integrity, index membership/content, score semantics, startup/restart readiness, 13 strict table hashes plus projection-content parity, API isolation, ambiguity rejection, exact three preview audits, zero requests/creation operations, no OOM/automatic restarts, owned cleanup and token removal; every value must be true for `Passed` |
| `data` | Before/after 14-table counts and raw hashes, projection-content SHA-256, separately counted timestamp changes and missing-score coverage; before/after candidates must match |
| `artifacts` | Relative filenames and SHA-256 values for source/asset/identity evidence, import, cold-before/after, both readiness reports, API receipt, envelope/health checks, timing and cleanup |
| `limitations` | `renderedDisclosureVerified: false`, `comprehensiveManualGate: false`, no ranking-quality or production-responsiveness claim; real integration/native-client checks remain separate |

Record compact reviewed facts and hashes in the required beta.4 release ledger row. Link retained artifacts where accessible, or identify the retention owner and storage class. Full artifacts may remain in the private evidence archive. Do not publish credentials, confirmation tokens, local paths, Docker endpoint/resource names, environment files, raw responses or unsanitized logs. The summary and evidence do not pass rendered disclosure or any other deferred comprehensive manual row.
