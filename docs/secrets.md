# Secrets

Local secret material for every managed repository lives in one folder beside
this workspace, `../matrix-secrets` (normally `~/github/matrix-secrets`), with
one namespace per repository. It is not a Git repository. Back it up and deploy
its CI values from here; repositories no longer carry their own backup scripts.
Set `MATRIX_SECRETS_DIR` to use another location.

## Layout

```text
matrix-secrets/
  README.md        Inventory of what each folder holds; names only, never values
  root/            Account-level originals; no repository links here
    legacy/        Kept without a current consumer
  <project>/       Named like the repository's matrix checkout
    staging/       Everything the staging tier reads
    prod/          Everything the production tier reads
    ci/
      secrets.env    GitHub Actions repository secrets
      variables.env  GitHub Actions repository variables
```

Each tier is self-contained:

- `shared.env` holds values copied from `root/root.env` that the project still
  uses. Rotate them into project-scoped keys, then drop them from `shared.env`.
- `app.env` holds the project's own values for the tier. Loaders read
  `shared.env` and then `app.env`, so the later file wins.
- Other files (keystores, store keys, service-account JSON, extra env files)
  keep the names their tooling expects.
- Commands that take no tier use `prod`. A project with one environment uses
  only `prod/` and leaves `staging/` empty.

Repository code reads `.secrets/<tier>/...`. It never reads `ci/` or another
project's folder. Run logs, plans, and probe output do not belong in
`matrix-secrets`; keep them in a session scratchpad and delete them once the
work ships.

## Linking a clone

Each clone or checkout links its gitignored `.secrets` to its project folder:

```sh
ln -s ../matrix-secrets/<project> ~/github/<clone>/.secrets
ln -s ../../../matrix-secrets/<project> checkouts/<project>/.secrets
```

Run `git check-ignore .secrets` in the clone after linking. A `.secrets/`
ignore pattern with a trailing slash does not match a symlink.

## Backups

```sh
bun run secrets:backup [output_dir] [--password-file <file>] [--no-password]
```

Archives the whole folder as `matrix-secrets/...` into `~/matrix-secrets-backups`
by default, with mode 600. Interactive runs prompt GPG for a passphrase
(AES-256). Non-interactive runs need `--password-file`, whose first line is the
passphrase, or an explicit `--no-password`. The passphrase never appears in
process arguments, the plaintext archive is never written to disk when
encrypting, and an output directory inside the secrets folder is refused.

## CI values

```sh
bun run secrets:deploy [repo...]          # compare names only
bun run secrets:deploy <repo> --apply     # set every value in the files
```

For each selected repository, the command reads only the names in
`ci/secrets.env` and `ci/variables.env` and compares them with the repository's
GitHub Actions secrets and variables. It reports `deploy` (names the files set)
and `unmanaged` (names on GitHub that the files do not mention). `--apply`
passes each non-empty file to `gh secret set --env-file` or `gh variable set
--env-file`, so values go from the file to GitHub without passing through
matrix, and marks each file `applied`. Nothing is deleted. A failure is recorded
on its repository, the others still run, and the command exits non-zero. Only
repository-level settings are managed; environment secrets stay manual.

GitHub cannot return a secret's value. An `unmanaged` secret has to be refilled
from its source before the file can own it.

## Terraform state

Each project's Terraform state bucket key (`TF_STATE_*`) lives in its tier
`app.env`; see [terraform-state.md](terraform-state.md).

## Rules for agents

- Never read, print, copy into logs, or commit secret values. Listing file
  names and variable names (`sed 's/=.*//'`) is fine.
- Change files in `matrix-secrets` only when the user asks. Take a backup first
  when moving or deleting anything.
- Sweeps that change how a repository reads secrets follow the layout above and
  update the inventory in `matrix-secrets/README.md`.
