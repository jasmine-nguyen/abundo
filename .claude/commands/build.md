---
description: Run the build graph for a card
---

Run the build pipeline for a card using `build_graph.py`.

1. Run `python3 build_graph.py $ARGUMENTS` and show the output.
2. If the script pauses (prints "Paused. Resume with:"), present the
   interrupt message to the user and ask for their decision.
3. Once the user responds, run
   `python3 build_graph.py <card_number> --resume "<their answer>"`
   and show the output.
4. Repeat steps 2-3 until the script prints "Done."
