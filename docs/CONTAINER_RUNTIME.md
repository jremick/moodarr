# Container runtime

Moodarr's supported container platform is Linux `amd64`. The application build
uses the pinned Node 24 builder. The final image contains Node 24 and its required
Wolfi packages, runs as `999:999`, and has no shell or package manager. The
`/nodejs/bin/node` path remains available for health checks and operator tools.

The runtime package files are locked by SHA-256 in
[`docker/runtime-packages.sha256`](../docker/runtime-packages.sha256), with exact
versions in [`docker/runtime-packages.lock`](../docker/runtime-packages.lock).
The build checks those hashes and authenticates package identities through the
preserved vendor-signed [`APK index`](../docker/runtime-APKINDEX.tar.gz). It installs
from that local repository with networking disabled and signature checks enabled.
The signed index is retained because the vendor packages do not all carry standalone
signatures; a newly generated unsigned index would break the trust chain. The final
image retains the installed package database so scanners can identify its contents.
Download and package-install tools are not copied into the runtime.

Wolfi supplies the native-library security fixes. Its Node build uses shared
OpenSSL and zlib, so updating those installed libraries also updates the libraries
Node loads. This avoids leaving a vulnerable statically bundled OpenSSL copy
behind an otherwise patched operating-system package.

The initial package set addresses CVE-2026-5435 and CVE-2026-19499 with
`glibc-2.44 2.44-r7`, CVE-2026-85091 with `zlib 1.3.2.1_rc20260601-r0`, and
CVE-2026-84782, CVE-2026-72897 and CVE-2026-84784 with OpenSSL `3.6.5-r0` and
its required `4.0.3-r0` libraries. The zlib package is a vendor-maintained
development snapshot with the upstream fix. See the [Wolfi security feed](https://packages.wolfi.dev/os/security.json)
and [OpenSSL advisory](https://mirror.openssl-library.org/news/secadv/20260929.txt).

## Refreshing the runtime

1. Verify the current vendor package-index signature and the required fixes.
   Keep the supported Node major and resolve the complete runtime dependency set.
2. Fetch the packages from the official Wolfi repository. Preserve its verified
   signed index, then update the complete version and checksum locks and the
   index hash in the Dockerfile. Update the pinned package-install image when
   necessary. Do not mix distributions or disable signature checks.
3. Build the final image. Read back Node's loaded library versions, installed
   package inventory, user, entrypoint and health check. Verify SQLite search,
   crypto, compression, international text, DNS and HTTPS certificate validation.
4. Run the packaging and container acceptance checks described in
   [the release guide](RELEASE.md). Scan the exact final image with a current
   vulnerability database, retain the report and reconcile its image digest.
   A clean scan does not replace package coverage or runtime verification.

Package pins do not update automatically. Refresh the complete set when applying
native-library fixes; updating only the build-stage image does not update the
locked runtime packages.
