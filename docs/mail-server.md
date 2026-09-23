# Orbis verification email

Orbis uses SMTP on the Relay server to send single-use registration codes to QQ mailboxes. The Windows Host receives neither SMTP credentials nor an administrator token. The administrator's QQ verification switch continues to apply independently of SMTP configuration.

## Connect an SMTP service

Set these values in `/opt/orbis/shared/relay.env`, owned by the deployment account with mode `600`:

```dotenv
ORBIS_SMTP_HOST=mail.example.com
ORBIS_SMTP_PORT=465
ORBIS_SMTP_USER=noreply@example.com
ORBIS_SMTP_PASSWORD=replace-with-a-unique-random-password
ORBIS_SMTP_FROM=Orbis <noreply@example.com>
```

Port 465 uses implicit TLS. Other ports require STARTTLS. The configured hostname must match a valid certificate; certificate verification must remain enabled. Docker environment files take the sender value literally, so do not add shell quotes around it. Check connectivity and SMTP authentication **from the Relay container**, not only from the server shell.

Run the repository's **Relay deploy** GitHub Actions workflow after changing the environment. The existing container retains its previous environment until replaced. The workflow skips an already deployed commit; use a new reviewed commit when applying a configuration change. Do not restart or replace the application manually as a deployment shortcut.

`GET /v1/registration/status` reports `mailConfigured`, `qqEmailVerificationRequired`, and `enabled`. Configuration presence does not establish successful delivery: request a code through `POST /v1/registration/code` with an operator-authorized QQ recipient and a test Host ID, inspect SMTP delivery logs, and confirm actual receipt. Do not activate a test Host or log/return its code merely to test email transport.

## Self-hosted sending service

A lightweight setup uses Postfix for transport and queues, Dovecot **only for SMTP authentication**, and OpenDKIM for signing. It does not need webmail, IMAP, POP3, or user mailbox login services.

- Listen on TCP 465 for authenticated TLS submission. Enforce sender ownership so the Orbis account can send only as `noreply@your-domain`.
- Listen on TCP 25 for delivery-status messages and the `postmaster`/`abuse` role addresses. Store these locally in a restricted administrative mailbox; this does not create a personal inbox service. Reject nonexistent recipients during SMTP and never accept unauthenticated relay to external domains.
- Dovecot authenticates against a dedicated password file containing a salted password hash. Disable OS/PAM login and all mailbox protocols. Provide its auth socket only to Postfix.
- OpenDKIM signs the authorized sender using a 2048-bit private key readable only by its service account. Sign authenticated application submissions, never untrusted incoming mail claiming your domain. Keep its milter socket on loopback and defer mail if signing is unavailable.
- Use the mail hostname's valid TLS certificate and reload Postfix from the certificate renewal deploy hook. Keep the ACME challenge route and renewal timer operational.
- Configure message size, submission rate, recipient and queue lifetime limits. If Fail2ban monitors Postfix, verify its filter sees the actual log source: Ubuntu's `postfix@-.service` journal unit may differ from the filter's default `postfix.service`. Watching `/var/log/mail.log` is an alternative when rsyslog writes that file.
- Restrict private files and backups. Monitor `postqueue -p`, delivery failures, certificate expiry, and storage used by local delivery-status messages. Do not commit mailbox contents, logs containing recipient data, SMTP passwords, DKIM private keys, or environment files.

### DNS and network

For a dedicated sender on `203.0.113.10`, replace the example addresses and publish:

| Type | Name | Content |
| --- | --- | --- |
| A | `mail` | `203.0.113.10` (DNS only) |
| MX | `@` | `mail.example.com`, priority 10 |
| TXT | `@` | `v=spf1 ip4:203.0.113.10 -all` |
| TXT | `mail` | `v=spf1 ip4:203.0.113.10 -all` |
| TXT | `selector._domainkey` | The generated DKIM **public** key |
| TXT | `_dmarc` | `v=DMARC1; p=none; adkim=s; aspf=s` |

The MX accepts delivery-status messages for the application sender; it does not imply a user-facing inbox. Keep only one SPF policy per name, merging other authorized senders if the domain already sends through another provider. Start DMARC with `p=none` during validation; tighten policy after checking the actual messages and accounting for every legitimate sender. Do not configure a reporting address unless it exists and is monitored.

Cloudflare's ordinary HTTP proxy does not transport SMTP. The mail A record must be DNS only; the website's records may remain proxied. Publishing this A record exposes the mail server IP. If mail shares the website origin, that origin is consequently public too.

Ask the IP provider to set **PTR/rDNS** to `mail.example.com`. Confirm both forward and reverse DNS publicly. A zone in Cloudflare normally cannot change a provider-owned reverse DNS zone. Use IPv4-only outbound delivery until IPv6 also has correct forward/reverse DNS and SPF authorization. Check outbound TCP 25 and inbound 25/465 from separate networks.

### Verify before enabling registration

1. Resolve A, MX, SPF, DKIM, and DMARC through authoritative and public resolvers. Confirm `opendkim-testkey -d YOUR_DOMAIN -s YOUR_SELECTOR -vvv` succeeds. Its `key not secure` diagnostic refers to DNSSEC and is separate from `key OK`.
2. Validate the TLS chain and hostname on 465, successful authentication, and rejection of anonymous submission, external relay, unknown local recipients, and authenticated sender spoofing.
3. Deliver a message locally and verify its DKIM signature. Verify an unauthenticated incoming message is not signed as your domain.
4. Send to an explicitly authorized QQ recipient. An SMTP `250` response means the receiving server accepted the message; confirm actual mailbox receipt separately, including spam placement.
5. Deploy the SMTP environment through GitHub Actions, confirm the deployed commit and public health, then request a real code through the registration endpoint. Keep the QQ verification policy unchanged.

The official service sends as `Orbis <noreply@orbising.com>` through `mail.orbising.com:465`. SMTP credentials remain on the production server and in private operational backups outside this repository.
