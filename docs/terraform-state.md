# Terraform state

Every managed repository that uses Terraform keeps its state in its own
Cloudflare R2 bucket, through Terraform's S3 backend with lockfile locking. No
state lives in AWS, and no repository shares a bucket with another.

## Convention

| Item | Value |
| --- | --- |
| Bucket | `<project>-terraform-state`; `<project>` is the matrix checkout name, with dots replaced by hyphens |
| Keys | `terraform.tfstate` for a single-stack repository; `<tier>/<stack>/terraform.tfstate` or `<stack>/terraform.tfstate` otherwise |
| Endpoint | `https://<account-id>.r2.cloudflarestorage.com`, region `auto` |
| Credentials | An account token named like the bucket, allowed only *Workers R2 Storage Bucket Item Write* on that bucket |
| Secrets | `TF_STATE_ACCESS_KEY_ID` (the token ID) and `TF_STATE_SECRET_ACCESS_KEY` (the SHA-256 of the token value) in `matrix-secrets/<project>/prod/app.env`, and in `staging/app.env` where a staging tier exists |

The backend block, shared by all repositories:

```hcl
terraform {
  backend "s3" {
    bucket = "<project>-terraform-state"
    key    = "terraform.tfstate"
    region = "auto"
    endpoints = {
      s3 = "https://<account-id>.r2.cloudflarestorage.com"
    }
    use_lockfile                = true
    use_path_style              = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
  }
}
```

Each repository's Terraform wrapper loads the tier's `.secrets` files and
exports the pair as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for the
Terraform process only, after unsetting `AWS_PROFILE` and `AWS_SESSION_TOKEN`.
CI validates with `-backend=false` and never reads state.

The buckets and tokens are created by hand, outside Terraform, before any
state exists. That way no stack depends on state stored in a bucket it manages.

## Adding a project

With the account-level Cloudflare token from `matrix-secrets/root/root.env`,
which can create account tokens:

1. `POST /accounts/{account_id}/r2/buckets` with `{"name": "<project>-terraform-state"}`.
2. `POST /accounts/{account_id}/tokens` with a single `allow` policy granting
   permission group `2efd5506f9c8494dacb1fa10a3e7d5b6` (*Workers R2 Storage
   Bucket Item Write*) on the resource
   `com.cloudflare.edge.r2.bucket.<account_id>_default_<bucket>`.
3. Write the token's `id`, and the SHA-256 of its `value`, to the project's
   `app.env` as shown above. The value is returned only once, so never print it.
4. Test the key with an S3 client against the endpoint; a new token can take a
   few seconds to work. Confirm it cannot read another project's bucket.

## Migration from AWS

Until 2026-10-16, state lived in AWS S3:
- `tearleads-terraform-state`, with the DynamoDB table `tearleads-terraform-locks`, held tearleads' stacks and skyline's.
- `resume-terraform` held a2f0.net.
- `devopsrockstars-terraform` held devopsrockstars.com.
- `dotfiles-terraform` held dotfiles.

The active objects were copied to the new buckets and checked byte for byte, so
lineage and serial are unchanged.

Every object in those buckets was archived in `matrix-secrets`, along with
`tearleads-terraform`, `new-relic-terraform`, and tearleads' local bootstrap
state. The buckets were then deleted.

Several archived states belonged to stacks whose code no longer exists. On
2026-10-16 the resources they still tracked were checked live and deleted by
hand, and then the archive was deleted. A copy survives in the
`matrix-secrets` backup that its README names.

These resources were kept, and no Terraform manages them now:
- AWS budgets and their `billing-alerts` topic.
- The `a2f0/tearleads` repository and its ruleset.
- tearleads.com's Google mail and verification DNS records.
- The Google Workspace groups.
- The Tailscale policy and keys.
- The Vercel project.
- The New Relic monitors.
