# pi-openviking

Pi extension that adapts OpenViking memory operations into a small Pi tool surface.

## Scope

This package is an adapter, not a second memory engine. OpenViking remains the storage/search backend.

## Tools

- `memsearch` — discover memories/resources by semantic query, exact text, glob, browse/tree, or stat.
- `memread` — read one `viking://` URI.
- `memadd` — write one curated memory/resource.

The extension intentionally does not expose low-level raw OpenViking write modes as public tools.

## Memory lanes

### `memory`

Long-lived, high-value facts that should influence future agent reasoning.

Default write URI:

```text
viking://user/default/memories/manual/<title>/<title>.md
```

### `resource`

Bulk notes, reference material, imported docs, and other content that should be searchable without becoming preference memory.

Default write URI:

```text
viking://resources/manual/<title>.md
```

## `memsearch`

`memsearch` is the discovery entrypoint.

Common inputs:

- `query`
- `strategy`: `semantic | exact | glob | browse | tree | stat`
- `target_uri`
- `mode`: `auto | fast | deep`
- `limit`
- `score_threshold`

Examples:

```ts
memsearch({ query: "agent collaboration preference", target_uri: "viking://user/default/memories/" })
memsearch({ strategy: "exact", query: "review discipline", target_uri: "viking://user" })
memsearch({ strategy: "glob", query: "**/*.md", target_uri: "viking://resources" })
memsearch({ strategy: "browse", query: "viking://user/default/memories/" })
```

Search results are candidates. Important conclusions should be confirmed with `memread`.

## `memread`

Reads one concrete URI.

Inputs:

- `uri`
- `level`: `auto | abstract | overview | read`

`auto` uses overview-style output for directories and full read output for files.

## `memadd`

Writes curated content.

Inputs:

- `title`
- `content`
- `lane`: `memory | resource`
- `target_uri` optional override

Behavior:

- creates parent directories when needed,
- creates new files when absent,
- replaces existing target content when updating,
- waits for OpenViking write completion when supported.

## Configuration

Configuration can come from environment variables or Pi settings.

Environment variables:

```text
OPENVIKING_ENDPOINT
OPENVIKING_API_KEY
OPENVIKING_ACCOUNT
OPENVIKING_USER
OPENVIKING_AGENT_ID
OPENVIKING_RECALL_USE_SEARCH
OPENVIKING_RECALL_DISPLAY
```

Pi settings example:

```json
{
  "openviking": {
    "endpoint": "http://localhost:1933",
    "account": "default",
    "user": "pi",
    "agentId": "pi-agent",
    "autoRecall": {
      "enabled": true,
      "useSearch": false,
      "limit": 4,
      "scoreThreshold": 0.55
    },
    "searchDefaults": {
      "limit": 8,
      "scoreThreshold": 0.5
    }
  }
}
```

## Prompt optimization

Optional prompt optimization reads VLM configuration from OpenViking config. If no VLM `api_base` is configured, the command reports the missing config and exits without using a hard-coded service endpoint.

## Operating principles

- Keep foreground recall lightweight.
- Use `memadd` for curated durable facts.
- Put bulk material in `resource` lane.
- Do not write directly into OpenViking index internals.
