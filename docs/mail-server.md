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

Use authenticated SMTP with a valid certificate and matching hostname, and verify connectivity from the Relay container. Port 465 uses implicit TLS; other ports use STARTTLS. Docker environment files take the sender value literally, including any quote characters.

Apply SMTP environment changes through the repository’s **Relay deploy** workflow using a new reviewed commit. Replacing the container loads the new environment.

`GET /v1/registration/status` reports `mailConfigured`, `qqEmailVerificationRequired` and `enabled`. Verify delivery through `POST /v1/registration/code` using an authorized QQ recipient and a test Host ID, keeping the code private and confirming mailbox receipt.

## Self-hosted sending service

A lightweight setup uses Postfix for transport and queues, Dovecot **only for SMTP authentication**, and OpenDKIM for signing. It does not need webmail, IMAP, POP3, or user mailbox login services.

Use authenticated TLS submission on TCP 465, recipient-validated delivery-status reception on TCP 25, and dedicated Dovecot authentication through a private Postfix socket. OpenDKIM signs authenticated application submissions using a restricted 2048-bit key and loopback milter.

Keep certificate renewal, bounded queues, private backups and delivery monitoring operational. Sender ownership and service-account access define the mail boundary. If Fail2ban uses journald, match the actual Postfix unit; Ubuntu may use `postfix@-.service`.

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

The MX handles application delivery-status messages. Maintain one SPF policy per name and validate DMARC with `p=none` before tightening it. Reporting addresses belong to monitored mailboxes.

Cloudflare's ordinary HTTP proxy does not transport SMTP. The mail A record must be DNS only; the website's records may remain proxied. Publishing this A record exposes the mail server IP. If mail shares the website origin, that origin is consequently public too.

Ask the IP provider to set **PTR/rDNS** to `mail.example.com`. Confirm both forward and reverse DNS publicly. A zone in Cloudflare normally cannot change a provider-owned reverse DNS zone. Use IPv4-only outbound delivery until IPv6 also has correct forward/reverse DNS and SPF authorization. Check outbound TCP 25 and inbound 25/465 from separate networks.

### Verify before enabling registration

Verify public DNS, DKIM, authenticated TLS, sender ownership and recipient handling before enabling registration. `opendkim-testkey -d YOUR_DOMAIN -s YOUR_SELECTOR -vvv` checks the published key; its DNSSEC diagnostic and key validity are separate results. Confirm actual receipt at an authorized QQ mailbox, then verify the deployed environment and registration path while preserving the operator’s policy.

## Production Resend SMTP

The official service sends as `Orbis <noreply@orbising.com>` through Resend:

```dotenv
ORBIS_SMTP_HOST=smtp.resend.com
ORBIS_SMTP_PORT=465
ORBIS_SMTP_USER=resend
ORBIS_SMTP_PASSWORD=domain-scoped-sending-only-resend-api-key
ORBIS_SMTP_FROM=Orbis <noreply@orbising.com>
```

Verify `orbising.com` in Resend and publish its supplied sending records alongside the existing website and mail records. Resend manages outbound IP and reverse DNS; the self-hosted checks apply to local mail transport.

Use a sending-only API key restricted to `orbising.com` as the SMTP password. Keep setup credentials, sending keys and private configuration backups outside the repository with mode `600`. Confirm TLS and SMTP authentication from the Relay container, apply the environment through the Relay deploy workflow at a new commit, and verify `mailConfigured` after deployment. Preserve the operator's QQ verification policy and test delivery only to an explicitly authorized recipient.
