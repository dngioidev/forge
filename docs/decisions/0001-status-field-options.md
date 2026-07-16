# ADR-0001 — Built-in Status field options are mutable; init creates the standard set on fresh projects only

**Date:** 2026-07-16 · **Status:** accepted · **Ticket:** #1 (SP1 spike, plan T4)

## Context

ProjectsV2 ships every new project with a built-in Status single-select (Todo / In Progress / Done). Forge's standard is six statuses (spec §6). It was unverified whether GraphQL can modify a *built-in* field's options ([spec §6 spike note](../specs/2026-07-15-forge-platform-design.md)).

## Finding (verified live, 2026-07-16, scratch project dngioidev/#9)

`updateProjectV2Field` **works** on the built-in Status field:

```graphql
mutation {
  updateProjectV2Field(input: {
    fieldId: "<status-field-id>",
    singleSelectOptions: [ {name: "Backlog", color: GRAY, description: ""}, … ]
  }) { projectV2Field { ... on ProjectV2SingleSelectField { options { id name } } } }
}
```

Caveat that decides everything: the mutation **replaces the entire option list and mints new option IDs** — existing options are destroyed, and items assigned to them lose their status.

## Decision

- **Fresh projects** (created by `forge init`, zero items): init replaces Status options with the forge 6-status set — full bootstrap, no manual step.
- **Adopted projects** (any existing items): init never touches Status options — it maps what exists (spec §6 degrade-gracefully) and prints the manual instruction for the owner to add missing statuses via the UI if wanted. Destroying live status assignments is not an acceptable default; an explicit `--force-status` opt-in may be added later if real need appears.

## Consequences

`forge init` needs an "is this project empty" check (items count == 0) to pick the path. The forge standard option set (names + colors) lives in one constant shared by init and doctor.
