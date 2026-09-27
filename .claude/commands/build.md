---
description: Run the build graph for a card or request
---

Run the build pipeline using `build_graph.py`.

1. Figure out what to build:
   - If `$ARGUMENTS` looks like a card number (e.g. WHIT-123), fetch the
     card's title and description from Notion first, then run:
     `python3 build_graph.py --card <number> --details "<title and description>"`
   - Otherwise treat it as an ad-hoc request and run:
     `python3 build_graph.py "$ARGUMENTS"`
2. If the script pauses (prints "Paused. Resume with:"), present the
   interrupt message to the user and ask for their decision.
3. Once the user responds, run the resume command shown in the output
   (e.g. `python3 build_graph.py --thread <id> --resume "<answer>"`)
4. Repeat steps 2-3 until the script prints "Done."
