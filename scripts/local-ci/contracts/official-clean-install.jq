# Official contract for clean-install. validate-beta-candidate.yml accepted this report on exit 0 alone;
# the local gate also requires the complete published-digest report. Derived from the rehearsal contract
# with the official candidate identity, releaseEligible true and zero unresolved incompletes.
.schema == "moodarr-beta-clean-install-v1"
and .candidate.kind == "official-digest"
and .candidate.digest == $digest
and .candidate.version == $version
and .candidate.revision == $revision
and ([.sourceHashes[]] | length == 4 and all(.[]; test("^[0-9a-f]{64}$")))
and .platform.endpointLocalUnix == true
and .platform.daemonOs == "linux"
and (.platform.daemonArch == "amd64" or .platform.daemonArch == "x86_64")
and .platform.imageOs == "linux"
and .platform.imageArch == "amd64"
and .platform.native == true
and .passed == true
and .releaseEligible == true
and .incomplete == []
and (.modes | keys | sort) == ["compose", "docker"]
and all(.modes[];
  .passed == true
  and .failures == []
  and .incomplete == []
  and (.checkCodes | length) == 25
  and (.checkCodes | unique | length) == 25
  and (.checkCodes | sort) == $expectedChecks
  and .counts == {lifecycles: 3, plexItems: 2, seerrItems: 3, searchResults: 1, posterBytes: 68, stubCalls: 35}
)
