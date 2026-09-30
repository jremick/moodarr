# Official contract for alpha21-upgrade-rollback. validate-beta-candidate.yml accepted this report on
# exit 0 alone; the local gate also requires the complete published-digest report.
.schema == "moodarr-beta-upgrade-validation-v1"
and .status == "passed"
and .mode == "official-candidate"
and .releaseEligible == true
and .images.candidate.indexDigest == $digest
and .images.candidate.version == $version
and .images.candidate.revision == $revision
and (.archive.sha256 | test("^[0-9a-f]{64}$"))
and ([.state.before, .state.candidate, .state.restarted, .state.rollback] | all(. != null))
and ([.database.before, .database.candidate, .database.plexRefreshed, .database.restarted, .database.rollback] | all(. != null))
and (.checks | length) == 107
and (.checks | unique | length) == 107
and (.checks | sort) == $expectedChecks
and .failures == []
and .incomplete == []
