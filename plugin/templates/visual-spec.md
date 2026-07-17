# Visual spec — {{COMPONENT}} (#{{TICKET}})

<!-- forge visual-spec template (spec §4 item 11). Every section below is
mandatory — speclint.mjs enforces their presence; design-reviewer validates
the implementation against their content. -->

## Summary
One paragraph: what this is, where it lives, the chosen variant's rationale.

## States matrix
| state | normal content | long content | extreme content |
| --- | --- | --- | --- |
| default | | | |
| hover | | | |
| focus | | | |
| active | | | |
| disabled | | | |
| loading | | | |
| empty | | | |
| error | | | |

## Breakpoints
Rendered at (≥3 widths): mobile 375 · tablet 768 · desktop 1280. Notes per width.

## Themes
Rendered in every configured theme (light / dark / …). Token-driven differences only.

## A11y contract
- Focus order:
- Roles / accessible names:
- Contrast pairs (token references):
- Target sizes:
- Reduced motion behavior:

## Motion
| element | property | duration token | easing token | reduced-motion |
| --- | --- | --- | --- | --- |

## Token delta
- Tokens used:
- New tokens proposed (token governance — these enter only through this spec's approval):
- One-off values: none (by definition — a one-off is a finding)

## Graph ripple
_(iterate/system modes — SP8. For NEW components: "new component, no consumers yet.")_
