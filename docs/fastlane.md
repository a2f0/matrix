# Fastlane releases

Every managed repository that ships iOS or Android store builds does so with
fastlane, in the same layout, under the same lane names, invoked the same way,
and reading the same secrets. Some have a staging app and some do not; the tier
table is the only place that difference shows.

| Repository | App directory (`APP_DIR`) | Tiers |
| --- | --- | --- |
| a2f0/nc | repository root | production |
| a2f0/rn-sandbox | repository root | production |
| a2f0/tearleads | `packages/app-capacitor` | production, staging |
| a2f0/balebase | `packages/app-capacitor` | production, staging |

`APP_DIR` is the directory that holds the native `ios/` and `android/`
projects: the repository root for React Native and the Capacitor package for
Capacitor.

## Layout

```text
.ruby-version                 Ruby pin; .mise.toml's ruby, when present, matches it
APP_DIR/
  Gemfile, Gemfile.lock       ruby file: '<relative path>/.ruby-version'; fastlane and rubocop
  .rubocop.yml                Excludes android/, ios/, node_modules/, vendor/; Metrics/BlockLength skips lanes/ios.rb and lanes/android.rb
  package.json                One script per routine lane (see Invocation)
  fastlane/
    Appfile                   app_identifier and package_name from the tier table
    Fastfile                  default_platform(:ios), skip_docs, and imports only
    lanes/ios.rb              platform :ios lanes and the helpers only they use
    lanes/android.rb          platform :android lanes and the helpers only they use
    lanes/store.rb            Lanes outside a platform and helpers both platforms use (optional)
    lib/native_release_target.rb  Tier table, secrets paths, and secrets loading
    lib/*.rb                  Plain Ruby helpers, no lane definitions, loaded with require_relative
    metadata/{ios,android}/   Store listing text (optional)
    test/*.test.ts            Lane and helper tests, run by the repository's test command
    test/support/             Ruby fakes and TypeScript helpers the tests load
```

fastlane defines `UI` only inside its own namespace, so `lib/` code reports
errors with `FastlaneCore::UI`; a bare `UI` there raises `NameError` in a real
run, and test fakes must not define a top-level `UI` that hides it.

The iOS signing keychain module is `lib/ios_signing_keychain.rb`
(`IosSigningKeychain`); each run creates a throwaway keychain and deletes it,
whether the build succeeds or fails.

## Tiers

`lib/native_release_target.rb` declares `NATIVE_RELEASE_TARGETS`, keyed by tier.
`production` is always present; `staging` exists only where the repository has a
staging app. Each entry gives at least the app identifier and its secrets tier
(`prod` or `staging`), plus what differs between tiers: Xcode scheme and
configuration, Gradle variant, and artifact names.

`NATIVE_RELEASE_TIER` selects the tier and defaults to `production`. An unknown
tier, or one the repository does not declare, fails before any lane runs and
names the declared tiers. The Appfile reads the selected app identifier, so the
variable has to be set in the environment rather than passed as a lane option.

## Lanes

Every repository has these lanes, with these names, options, and `desc`
strings. `track:` defaults to `internal` and `release_status:` to `completed`:

| Lane | `desc` |
| --- | --- |
| `ios build_release` | Build a signed App Store IPA without uploading it (build_number:) |
| `ios upload_release` | Run build_release, then upload to TestFlight (build_number:) |
| `ios profiles` | Create or renew the match App Store profiles (force:true regenerates them) |
| `android build_release` | Build a signed release App Bundle without uploading it (build_number:) |
| `android upload_release` | Run build_release, then upload to a Google Play track (build_number:, track:internal, release_status:completed) |

A repository that needs any of these uses these names:

| Lane | Does |
| --- | --- |
| `ios register_identifiers` | Registers bundle IDs and capabilities (API key) |
| `ios create_app` | One time, interactive: creates the App Store Connect app (Apple ID and 2FA) |
| `ios fetch_profiles` | Installs the match App Store profiles read-only |
| `android promote_release` | Promotes the open testing release to production (`version_code:`, `rollout:`) |
| `store_build_numbers` | Prints the latest build numbers in both stores |
| `ios listing`, `android listing` | Uploads the store listing from `fastlane/metadata/` |
| `ios readiness`, `android readiness` | Inspects a candidate and its store state, read-only |
| `android build_debug_apk`, `android build_release_apk` | Builds an APK for sideloading |
| `android install_debug`, `android install_release`, `android sideload` | Builds and installs an APK on a connected device |
| `android test`, `android clean` | Runs the Gradle unit tests; removes Gradle build outputs |

`build_number:` is the iOS build number or the Android version code. Without
it, each repository picks the next number its own way. Lanes that only one
repository needs keep repository-specific names. The required lanes use the
`desc` strings above word for word, and a comment above the lane carries
anything specific to the repository. Every other `desc` is an imperative
sentence that names its options in parentheses; repositories that share code,
such as the two Capacitor apps, use the same wording.

## Invocation

Lanes run from `APP_DIR` as `bundle exec fastlane <platform> <lane>
[key:value ...]`, with `NATIVE_RELEASE_TIER` set for staging.

`APP_DIR/package.json` exposes each routine lane as a script named
`<platform>:<lane in kebab case>`, with a `:staging` variant of each store lane
where the tier exists. Each script sets the tier explicitly; arguments pass
through to fastlane. One-time setup lanes run through `bundle exec fastlane`
and need no script:

```json
"ios:build-release": "NATIVE_RELEASE_TIER=production bundle exec fastlane ios build_release",
"ios:upload-release:staging": "NATIVE_RELEASE_TIER=staging bundle exec fastlane ios upload_release"
```

`store_build_numbers` is `store:build-numbers`. Repositories that wrap releases
in repository-root scripts name them
`scripts/{build,upload}{Ios,Android}[Staging]Release.sh` and delegate to these
package scripts.

## Secrets

Lanes read `.secrets/<secrets tier>/`, the clone's link into
`../matrix-secrets/<project>/` (see [secrets](secrets.md)), unless
`NATIVE_RELEASE_SECRETS_DIR` names another folder, as tests do; a relative
path resolves against `APP_DIR`. They load
`shared.env` and then `app.env`, import only the names the lane needs (both
files also hold unrelated server values), and never override a variable already
in the environment.

| File | Contents |
| --- | --- |
| `shared.env` | Values copied from `root/root.env`: `TEAM_ID`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `MATCH_GIT_URL`, `MATCH_GIT_BASIC_AUTHORIZATION`, `MATCH_PASSWORD`, and `APPLE_ID` and `ITC_TEAM_ID` where `create_app` exists |
| `app.env` | `ANDROID_KEYSTORE_STORE_PASS` and `ANDROID_KEYSTORE_KEY_PASS` for the project's upload key |
| `AuthKey_<APP_STORE_CONNECT_KEY_ID>.p8` | App Store Connect API key |
| `google-play-service-account-admin.json` | Google Play publishing service account |
| `<project>-upload.keystore` | Android upload key |

Gradle reads both passwords from the environment the lanes set up and signs
with the keystore in the same secrets folder, so overriding the folder moves
all three together. A value
copied from `root/root.env` stays in `shared.env` until it is rotated into a
project key, so a loader always reads both files.

## Validation

`bundle exec fastlane lanes`, for each declared tier, lists exactly the lanes
above that the repository has. `bundle exec rubocop` and the fastlane tests run
in the repository's lint and test gates. Lanes that upload, promote, change
profiles, or publish listings run only for a release.
