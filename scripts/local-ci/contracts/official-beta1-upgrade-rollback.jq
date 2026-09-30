# Official contract for beta1-upgrade-rollback. validate-beta-candidate.yml accepted this report on
# exit 0 alone; the local gate applies the same complete contract the workflow applies to beta.4 and beta.5.
.schema == "moodarr-beta1-upgrade-v1"
and .passed == true and .releaseEligible == true
and .candidate.version == $version and .candidate.revision == $revision
and .candidate.image == $image
and .baseline.version == "0.1.0-beta.1"
and .baseline.revision == "08447e87df2e1705aa9a79193a52a65fb00724c3"
and .baseline.image == "ghcr.io/jremick/moodarr@sha256:c1558d33b1e38c01d7d77171354464dd2b507fd6b84b353f2b0e11372ed73157"
and .platform.native == true
and ([.sourceHashes[]] | length == 4 and all(.[]; test("^[0-9a-f]{64}$")))
and (.archiveSha256 | test("^[0-9a-f]{64}$"))
and (.checks | length) == 7 and (.checks | sort) == $expectedChecks
and .lifecycle.passed == true
and .lifecycle.failures == [] and .lifecycle.incomplete == []
and (.lifecycle.checkCodes | length) == 25
and (.lifecycle.checkCodes | unique | length) == 25
and (.lifecycle.checkCodes | sort) == $expectedLifecycleChecks
and .lifecycle.counts == {lifecycles: 3, plexItems: 2, seerrItems: 3, searchResults: 1, posterBytes: 68, stubCalls: 35}
and .incomplete == []
