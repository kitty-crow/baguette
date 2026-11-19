# Host filesystem access

`pathExists(path)` checks access through the standard Node-compatible filesystem API. A failed access returns false, allowing the caller to prepare missing build artefacts or reject an unavailable input.
