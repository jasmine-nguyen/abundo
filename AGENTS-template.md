# <Project Name>

## Board

Notion data source: `collection://<your-board-id>`
Card prefix: `<PREFIX>`
Default card type: `<type option from your board, e.g. Task, Feature>`

## Card picking

Sort field: `<property name that controls build order, e.g. Order>`
Blocker relation: `<relation property name, e.g. Blocked by>`
Skip cards matching: `<optional pattern to exclude, remove line if not needed>`

If your board doesn't have a sort field or blocker relation, remove those
lines — /build will fall back to sorting by Priority (High > Medium > Low).

## Stack

- **Client:** ...
- **Server:** ...
- **Tests:** ...
- **Typecheck:** ...

## Checks

The build runs these after every implementation round, from the repo root, one
per line. Any non-zero exit sends the work back
to the implementer. The build won't start without this block. Keep them fast
and deterministic.

The lines run at the same time. Join steps that must happen in order with `&&` on
one line, or add a `# one at a time` line to the block to run them in order.

```checks
<typecheck command, e.g. npx tsc --noEmit>
<lint command, e.g. npm run lint>
<test command, e.g. npm test>
```

## Glossary

Domain terms agents must use in names, tests and plans.

- **<Term>** — <what it means here>. _Avoid_: <synonyms that mean the same thing>

## Known landmines

Check these before changing the touched area:

- ...

## Coding standards

- ...

## Hot shared files

...
