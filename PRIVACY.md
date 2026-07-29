# Privacy Policy

**GeorgesPaul Form Filler** (the "extension"), for Firefox and Chrome.

Effective 29 July 2026.

## The short version

The extension has no server. Nothing is sent to the developer, ever. There is no
telemetry, no analytics, no advertising, and no tracking of any kind.

One thing does leave your computer, and only when you ask for it: to work out
which of your details belongs in which form field, the extension sends your
profile text and a description of the form to the language model service **you**
configured, using **your** API key and **your** account with that service.

## What is stored on your device

All of it is kept in the browser's local extension storage, on your machine:

- **Profiles.** Free-form text you type in: name, address, email, phone number,
  and anything else you choose to put there.
- **Language model settings.** The endpoint URL, the model name, and the API key
  you entered.
- **KeePass settings.** Which database file you selected, and, if you imported it
  that way, the contents of the `.kdbx` file itself. It stays encrypted exactly
  as KeePass wrote it; the master password is never stored.
- **Preferences,** such as whether vision mode is on.

None of this is synchronised to a browser account: the extension uses local
storage only, never `storage.sync`. Nobody but you and the programs on your
computer can read it.

## What leaves your device

Only when you click **Fill**, and only to the endpoint you configured (OpenRouter
by default), the extension sends:

1. **The complete text of the selected profiles.** The whole profile is included
   in the request, not only the parts that turn out to match the form.
2. **A description of the form's fields:** labels, placeholder text, the visible
   text near each field, the options of dropdown lists, and any values already in
   the fields.
3. **A screenshot of the visible part of the page,** if you have switched vision
   mode on.

That request goes directly from your browser to that service, authenticated with
your own API key. The developer has no server in the path and receives no copy.

Once the data reaches that service it is governed by that company's privacy
policy and terms, not by this one. If you use the default, that is
[OpenRouter](https://openrouter.ai/privacy). If you point the extension at a
model running on your own machine, nothing leaves your computer at all.

Nothing is sent on pages you have not clicked Fill on. Until then the extension
sits idle: it does not read pages, watch what you type, or record where you go.

## Payment card details

The extension recognises credit card fields (number, cardholder name, expiry,
CVV) and will fill them from your profile.

Be aware of what that means given the section above: **if you store card details
in a profile, they are sent to your configured language model service** along
with the rest of the profile text whenever you fill a form. If you are not
comfortable with that, keep card details out of your profiles, or point the
extension at a model running locally.

## Passwords and KeePass

Passwords are handled on a separate path that never touches the network.

- Password fields are excluded from the language model request entirely. They are
  filtered out before the form description is built.
- Credentials come from your own KeePass database, unlocked with a master
  password you type each session. The database is decrypted in the browser, the
  entry is held in memory, and the username and password are typed straight into
  the page.
- Neither the master password nor any credential is sent to the language model
  service, to the developer, or anywhere else off your machine.

## What the extension never does

- It never sends anything to the developer. There is no server to send it to.
- It never collects telemetry, analytics, usage statistics, or crash reports.
- It never reads or transmits your browsing history, and it does not look at tab
  URLs or titles.
- It never sells or shares your data with anyone. There is no third party in the
  picture other than the model service you chose yourself.
- It contains no advertising and no third-party trackers.

## Deleting your data

Removing the extension deletes everything it stored. You can also clear
individual items at any time from the side panel: delete a profile, remove the
API key, or clear the KeePass database selection.

Data already sent to your model service is out of the extension's hands. Delete
it through that service's own controls.

## Changes to this policy

Material changes will be published here, with the effective date updated. The
history of this file is public in the repository, so every change is on the
record.

## Source

The extension is open source. Everything described here can be checked in the
code: <https://github.com/GeorgesPaul/formfill>

## Contact

Questions about privacy, or a mistake in this document: formfill@megahard.pro, or
open an issue at <https://github.com/GeorgesPaul/formfill/issues>.
