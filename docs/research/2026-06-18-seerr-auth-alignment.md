# Seerr Auth Alignment

Date: 2026-06-18

## Sources

- [seerr-team/seerr README](https://github.com/seerr-team/seerr)
- [Seerr documentation: Adding Users](https://docs.seerr.dev/using-seerr/users/adding-users/)
- [Seerr product site](https://seerr.dev/)

## Relevant Seerr Behavior

- Seerr presents Plex as a first-class media-server integration with authentication, user import, and user management.
- Plex user import is optional; users with access to the configured Plex server can sign in and receive default permissions on first login.
- Admins can disable new Plex sign-ins when first-login account creation should be closed.
- Seerr has a granular permission system. Moodarr does not yet need that full model because current non-admin actions are limited to Finder, item reads, poster reads, request preview, and explicit request creation.

## Moodarr Alignment Decision

Moodarr should align with Seerr on the first-login Plex identity model, not on a local-password model:

- Plex sign-in verifies the account with plex.tv.
- Moodarr checks that the Plex account can access the configured Plex server before creating a session.
- Moodarr stores a local user row for visibility and enable/disable control.
- Moodarr stores only a hashed Moodarr session token, not the Plex user access token.
- Admin settings, diagnostics, sync controls, and user management remain behind the existing admin token/session.

## Follow-Up

- Revisit roles and request limits only when Moodarr has real multi-user demand.
- If Moodarr becomes internet-facing, evaluate OIDC or reverse-proxy auth rather than expanding Plex auth into the only perimeter.
