# NAMMA SPACE — 3D Video Capture & Surveyor Guide

To produce clean, watertight, and photorealistic 3D digital twins with Structure-from-Motion (SfM), camera footage must provide high-quality geometric parallax and dense visual feature correspondence.

Follow these rules when capturing video footage with your smartphone:

---

## 1. Camera Motion: Orbit & Translate, Never Pivot in Place
- **DO:** Walk slowly around the room or object in an arc or perimeter loop.
- **DO NOT:** Stand in the center of the room and pivot the phone on its axis like a panoramic tripod. Pure rotation produces zero parallax, making triangulation mathematically impossible.
- **Trajectory:** For a bedroom or office, walk a complete circular or rectangular loop along the walls facing inward at a 45° angle.

---

## 2. Pacing & Motion Blur
- **Speed:** Walk slowly (approximately **1 step per 2 seconds**).
- **Smoothness:** Hold the phone with both hands close to your chest to dampen footsteps. Avoid sudden jerky camera rotations or quick tilt adjustments.
- **Why it matters:** SIFT and ORB feature extractors cannot detect keypoints on motion-blurred frames. Blurry frames degrade reconstruction or cause early rejection.

---

## 3. Visual Overlap & Feature Tracking
- Maintain at least **$60\%$ to $70\%$ visual overlap** between consecutive viewpoints.
- Keep distinctive visual landmarks (furniture, artwork, doorframes, textured rugs) in view across multiple seconds.

---

## 4. Loop Closure: Always Finish Where You Started
- When mapping a room or corridor, complete a closed loop by returning to the exact starting viewpoint for the final 3–5 seconds.
- **Why it matters:** Loop closure links the first and last camera poses, eliminating cumulative scale and orientation drift, and locking the structural shell into a closed polygon.

---

## 5. Lighting & Reflections
- **Illumination:** Turn on all ceiling lights and interior lamps. Avoid deep shadows.
- **Avoid Direct Sun Blinding:** Avoid pointing the phone directly into sun-lit window glass, which causes exposure blowout (pure white overexposure).
- **Reflective Surfaces:** Glass tables, mirrors, and polished chrome reflect changing virtual scenes as the camera moves, confusing photogrammetry. If a room has large mirrors, capture them obliquely or cover reflective glass during capture.

---

## 6. Plain & Blank White Walls
- Monocular photogrammetry requires visual texture to extract corner and gradient features.
- A blank, untextured white wall has zero SIFT features.
- **Surveyor Pro-Tip:** When surveying plain walls, keep textured foreground objects (desks, baseboards, light switches, wall outlets, or floorboards) in the bottom third of the camera frame to anchor camera tracking.

---

## Summary Checklist Before You Hit Record
| Checklist Item | Target | Why |
| :--- | :--- | :--- |
| **Pacing** | $\sim 0.5\text{ m/s}$ (slow steps) | Prevents motion blur |
| **Trajectory** | Perimeter loop around room | Maximizes baseline parallax |
| **Duration** | $45$ to $90\text{ seconds}$ | Provides $60$–$80$ quality keyframes |
| **Overlap** | $\ge 65\%$ between camera angles | Prevents track fragmentation |
| **Lighting** | Balanced, diffuse interior light | High keypoint contrast |
| **End Frame** | Match the start frame | Guarantees loop closure |
