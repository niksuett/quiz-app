# Three daily games — concept briefs

Short descriptions of three existing browser games, written as a starting point for rebuilding them. The scoring is described broadly on purpose: the exact formula is an implementation decision, not part of the concept.

---

## 1. Reborder

*Original: reborder.app*

A daily geography game. Each round shows a map of two neighbouring countries — both filled in, but the border between them is missing. You draw a single freehand line where you think it runs, submit, and the game reveals the true border on top of your line and scores the attempt out of 100.

**Scoring, broadly**

It compares the shape and position of your line against the real border. The closer your line sits to the true one along its whole length, the higher the score. It also cares that you covered the right stretch — a short scribble in roughly the right place scores badly even if every point of it is close. Wildly wrong lines get zero rather than a small consolation score. Top scores earn a "Master Cartographer"-style label; bad ones get a joke rating.


**Data**

Country boundary geometry. Natural Earth's public country outlines work — extract the shared boundary between each pair of neighbours.

---

## 2. Size It Up

*Original: magnitudle.com/size-it-up*

A daily estimation game about scale. Each round shows two silhouettes side by side: a small brown **reference** object whose real size is known and fixed (a human, for example), and a red **target** silhouette. You drag and resize the target until it looks the right size relative to the reference. Submit, and it reveals the true size and how far off you were.

**Scoring, broadly**

Based on relative error — how far your estimate is from the real size as a percentage of it, not in absolute terms. Being within a few percent is worth full marks; from there the points fall off steadily, and once you're off by more than roughly a factor of two-and-a-half you get nothing. Five rounds a day, 100 points each, with an overall grade at the end.

**Data**

For each object: a silhouette shape, its real-world size in metres, and which dimension that size refers to (length or height).

**Worth knowing before you start**

The tricky part isn't the scoring, it's the canvas — panning, zooming, and resizing the silhouette smoothly on both touch and mouse.

---

## 3. GeoSlice — Halves

*Original: geoslice.net/play-halves*

A daily geography game about population, not area. Each round drops you on a map zoomed to a region, with a straight line lying across it. You drag the line — moving it and rotating it — until you think it cuts the region's **population** into two equal halves. Then you lock in the split and it shows you the true figures.

The catch is that area and population look nothing alike. A line that visually halves the map usually puts 80 % of the people on one side, because everyone lives in a few cities.

**Interface**

The line sits on top of a normal pan-and-zoom map, so there's a toggle between "Line" mode (dragging moves your line) and "Pan" mode (dragging moves the map and leaves your line alone). After locking in, the two halves are shaded and labelled with their real percentages and population counts, and if you weren't near-perfect it also shows where the ideal line would have been.

**Scoring, broadly**

Only the imbalance matters. A dead-even split scores 100, and the score falls off along a curve as the gap widens, hitting zero when everything ends up on one side. Roughly: 55/45 still scores well, 70/30 lands mid-table, past about 90/10 is worth nothing. Three rounds a day, plus a streak.

**Data**

A gridded population raster (the kind WorldPop publishes), so you can sum how many people fall on each side of an arbitrary line — plus boundary shapes if you want country or region variants. The original pre-chops its grid into binary tiles and loads only what the current view needs; worth doing, since the raw global grid is large.

**Later**

The same site has Thirds and Quarters modes that work identically with three spokes or two crossed lines.
