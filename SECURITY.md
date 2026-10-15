# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately instead, from this
repository's **Security** tab, with **Report a vulnerability**. Only the maintainer sees the report,
and you will get an answer there.

Useful things to include: what an attacker could do, the steps to reproduce it, and the version of
the plugin (`plugin/.claude-plugin/plugin.json`) or of the page you tested.

## What matters most here

The plugin runs inside every Claude Code session of a station's repos, and the page holds that
station's sessions, orders and configuration. Reports about any of these are especially welcome:

- a way for an agent to write to a station, or to deliver an order, without the user's approval;
- a way for one station, or one account, to read or write another's data;
- a session report that leaks more than the plugin means to send (file paths, command arguments,
  secrets);
- a page that runs content from the station's database as code.

## Supported versions

Only the latest version on the `main` branch is supported.
