# Chrome Web Store: privacy practices

Copy-paste answers for the **Privacy practices** tab of the developer dashboard.
Keep this file in step with `manifests\manifest.chrome.json`: a permission added
there needs a justification here, and Google re-reviews the whole tab on every
submission.

Everything below is what the code actually does, verified against `src\`. If you
change the data flow, change this text, or the listing becomes a false statement
to Google rather than a stale note to yourself.

---

## Single purpose

> GeorgesPaul Form Filler fills web forms from profile data the user has saved in
> the extension. The user stores their own details as plain text (name, address,
> contact details, and any free-form notes), opens a page with a form, and clicks
> Fill in the side panel. The extension reads the form's fields, works out which
> profile value belongs in each one, and types them in. For login forms it can
> instead fetch a username and password from the user's own local KeePass
> database file. That is the extension's only function: it has no other feature,
> no background activity, and does nothing at all until the user clicks Fill.

---

## Permission justifications

### `storage`

> Profiles, the LLM endpoint/model/API key, and the selected KeePass database are
> saved with chrome.storage.local so they survive a browser restart. Everything
> stays in local storage: the extension does not use chrome.storage.sync, so none
> of it is uploaded to a Google account.

### `scripting`

> The content scripts that read and fill a form are declared for all pages, but a
> tab that was already open when the extension was installed or updated has no
> script running in it yet. scripting.executeScript injects them into the active
> tab when the user clicks Fill, so the first fill after an install works instead
> of silently doing nothing. It only ever injects the extension's own bundled
> files into the tab the user is acting on.

### `sidePanel`

> The extension's entire UI is the side panel: profile list, profile editor, the
> Fill button, and the progress readout. It is a side panel rather than a popup
> because filling a long form takes several seconds and involves clicking into
> the page, which would close a popup mid-fill.

### `activeTab`

> When the user clicks Fill, the extension acts on the tab they are looking at:
> it reads that tab's form fields and, in vision mode, captures the visible area
> to send to the model. activeTab scopes that work to the tab the user invoked
> the extension on.

### `tabs`

> The side panel needs the id of the active tab so it can send it the fill
> command and capture its visible area for vision mode. Only the tab id is used.
> The extension never reads tab URLs, titles, favicons, or browsing history.

### Host permission `<all_urls>`

> This is a general-purpose form filler, so the sites it has to work on are
> whichever ones the user happens to be filling a form on. There is no smaller
> set of hosts that would work: restricting it to a list would mean the extension
> silently fails on every site not on the list, and the user cannot tell us in
> advance which those are.
>
> On a matched page the content script does nothing until the user clicks Fill.
> It then reads the fillable fields (labels, placeholders, nearby text, current
> values, select options) and types values into them. It does not read or send
> anything on pages the user has not acted on. all_frames is required because
> signup and checkout forms are routinely inside an iframe.

### Remote code

Answer: **No, I am not using remote code.**

> All executable code ships inside the package. The extension makes HTTPS calls
> to the language-model endpoint the user configured and receives JSON back,
> which it treats strictly as data: strings to type into form fields. Nothing
> received over the network is evaluated or injected as script. There is no
> eval(), no new Function(), and no remotely hosted script or stylesheet.

---

## Data usage

Tick these types:

| Type | Tick | Why |
|---|---|---|
| Personally identifiable information | yes | Profiles hold name, address, email, phone. |
| Authentication information | yes | KeePass entries are read and typed into login forms. |
| Website content | yes | Field labels and surrounding text (and a screenshot in vision mode) go to the model. |
| Financial and payment information | yes | The heuristic filler targets card number, cardholder, expiry and CVV fields. |
| Health, location, web history, personal communications, user activity | no | Never touched. The extension synthesizes keystrokes; it does not record the user's. |

**Financial is not optional.** `heuristicFiller.js` has explicit rules for
`cc_number`, `cc_name`, `cc_exp_month`, `cc_exp_year` and `cc_csc`, matched from
autocomplete attributes and label patterns. The extension advertises card filling
in its own README, so leaving the box unticked is a false declaration a reviewer
can spot by reading the source. Note also that the heuristic path fills cards
locally, but the full profile text still goes into the model prompt on every
fill, so card details in a profile are transmitted: PRIVACY.md says so plainly
and the listing should not imply otherwise.

All three certification checkboxes can be ticked truthfully:

- not sold or transferred to third parties outside the approved use cases
- not used or transferred for anything unrelated to the single purpose
- not used for creditworthiness or lending

### The disclosure that matters

Form data is sent to a third-party language model. Be explicit about it in the
listing description as well as the privacy policy, because a reviewer who finds
it in the code but not in the listing treats it as an undisclosed transfer:

> To decide which value belongs in which field, the extension sends the profile
> text and a description of the form's fields to the language model endpoint the
> user configured (OpenRouter by default) using the user's own API key. In vision
> mode a screenshot of the visible page is sent as well. The user chooses the
> endpoint and holds the account; the developer operates no server, receives no
> data, and there is no telemetry or analytics of any kind.
>
> Password fields are excluded from that path entirely. KeePass credentials are
> read from the user's local database file, held in memory, and typed straight
> into the page. They are never sent to the model or anywhere else off the
> machine.

### Privacy policy

A privacy policy URL is **required** once any data type is ticked. Use:

    https://github.com/GeorgesPaul/formfill/blob/main/PRIVACY.md

The source of that page is `PRIVACY.md` at the repo root. Keep it and this file
saying the same thing: the reviewer reads both.
