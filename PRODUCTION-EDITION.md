# Production editions

This source fork adapts **circle-take** for children's 3D animated videos (ages 5–8) and realistic biblical-period cinema. The `kids-3d` branch defaults to children's animation; `biblical-period` defaults to biblical cinema. Original author credits, licenses and notices remain in place. Modified 2026-10-24.

## Children's 3D animation

Use original characters with approved turnarounds, expressions, proportions, wardrobe and material references. Plan clear emotional beats, gentle humor, cooperative problem solving and a reassuring resolution. Use smooth motivated camera moves and time to read actions and reactions. Review intense content, imitable behavior, sound peaks and flashes with an adult editor for ages 5–8.

## Biblical cinema

Select **Original period story** or **Scripture adaptation** in the production settings where the app has projects. Choose an exact era, geography and community before look development. Keep an evidence ledger for material culture and label uncertainty; the prompt guidelines do not themselves establish historical facts.

For Scripture adaptation, record book/chapter/verses and translation. Track direct quotation, paraphrase, historical inference and invented dialogue separately. For original fiction, identify the story as invented historical fiction set in biblical times. Human reviewers resolve interpretive choices.

## Build and workflow

Use the build and development commands in this app's original README. These branches contain source changes; existing upstream release downloads do not contain the editions. The suite hub provides branch-pinned source setup and project handoffs: https://github.com/echobb8/wassermans-filmmaker-suite/tree/biblical-period

Production settings are saved per project in Slate, Blockout (per scene), Storyboard Reference Studio, Circle Take, Cork Board and Master Canvas, and per session in Motion Previs Studio. In ScriptBreak they are saved with the project state and included in prompt-pack headers. Stem Studio prioritizes dialogue polish and offers sound-review guidance. Call Sheet points at edition-specific bundles. The DaVinci MCP exposes the read-only `production_brief` tool.

Generated media still requires an external video/image model. No children's-animation or biblical-period model weights are bundled or trained by this change. Blockout remains a previs tool, and live-action face/anatomy detectors may mis-score stylized 3D characters. Manual content and historical reviews are explicit, not automatic verdicts.

Upstream source: https://github.com/wassermanproductions/circle-take
Upstream revision: `45c0a46b51cc82cb91d0d2910c6c38e4e48a3996`
