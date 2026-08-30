# Ordinary camera cuts are not screenplay transitions

FrameScript's local temporal scanner emits `scene-change` visual evidence when it detects a picture cut. That signal is useful for scene-boundary scoring, but it is not evidence that an authored screenplay should contain `CUT TO:`.

A shot/reverse-shot conversation can contain many camera cuts while remaining one scene. Rendering each cut as a transition produces noisy output and falsely claims editorial intent that the evidence does not establish.

Policy:

- keep `scene-change` events in the evidence timeline;
- use them as one signal among several when scoring scene boundaries;
- do not convert a raw camera cut directly into a screenplay transition beat;
- reserve explicit transition text (`CUT TO:`, `SMASH CUT TO:`, `MATCH CUT TO:`, `FADE OUT:`) for future higher-level evidence that specifically supports that editorial transition.

This decision intentionally preserves the existing boundary detector, which already treats a lone picture cut as insufficient to split a scene.
