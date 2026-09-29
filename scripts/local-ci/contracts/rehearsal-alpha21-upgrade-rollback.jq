# Rehearsal contract for alpha21-upgrade-rollback, copied verbatim from .github/workflows/ci.yml
# (native-source-validation, "Run and validate release-ineligible native rehearsal").
.schema == "moodarr-beta-upgrade-validation-v1"
and .status == "incomplete"
and .mode == "local-rehearsal"
and .releaseEligible == false
and .images.candidate.version == $version
and .images.candidate.revision == $revision
and (.archive.sha256 | test("^[0-9a-f]{64}$"))
and ([.state.before, .state.candidate, .state.restarted, .state.rollback] | all(. != null))
and ([.database.before, .database.candidate, .database.plexRefreshed, .database.restarted, .database.rollback] | all(. != null))
and (.checks | length) == 107
and (.checks | unique | length) == 107
and (.checks | sort) == $expectedChecks
and .failures == []
and .incomplete == ["local_rehearsal"]
