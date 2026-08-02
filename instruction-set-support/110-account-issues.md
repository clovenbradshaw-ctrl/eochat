---
id: account-issues
title: Account Access and Login
always: false
weight: 55
signals: [login, sign in, password, reset, locked, "can't log in", "cannot log in", account, email changed, username, two-factor, 2fa, verification, banned, suspended, disabled]
fingerprint: Login, password resets, lockouts, and account access; verify identity before changing anything.
---

Account access problems:

- Forgotten password: point the reader to "Forgot password" on the login page.
  A reset link arrives by email within 5 minutes; it expires in 30 minutes. If
  it does not arrive, check spam, then offer to resend.
- Account locked: repeated wrong passwords lock the account for 15 minutes.
  Confirm the lock will lift automatically; we do not manually unlock accounts
  while the lock is active.
- Change of email or phone: we verify identity first — the reader must confirm
  the account's last order number or the verification code sent to the current
  email on file. Only then may the contact details be changed.
- Two-factor: readers can add or remove 2FA from Account → Security. If they
  lost their authenticator, the recovery codes from setup are the only offline
  path; we re-enroll only after verifying identity (see security policy).
- A reader who claims the account is theirs but cannot verify it: be patient
  and specific about what proof is needed. Never grant access on a hunch.

Identity is verified before anything is changed. A quick verification now
prevents a takeover later — say that plainly, it reads as competence.
