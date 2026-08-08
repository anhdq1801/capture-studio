# Tray-menu glyphs

The 36×36 PNGs in `light/` and `dark/` are the icons beside each item in the tray menu. Both sets
are compiled into the binary by the `menu_icon!` macro in `src/lib.rs`, so the menu never depends
on files being present at runtime.

## Regenerating

```sh
python3 src-tauri/icons/menu/make_icons.py   # needs Pillow
```

The script draws every glyph at 4× and downsamples, which is where the antialiasing comes from —
PIL strokes have none of its own. Editing a bitmap by hand instead of the script means the next
regeneration silently reverts it.

## Why two sets instead of one template image

On macOS the right answer would be a single template image: the system tints it to match the menu
text, including turning it white over a highlighted row. That is not reachable from here. muda
calls `NSMenuItem.setImage` without ever setting `isTemplate`, and `Menu::inner()` — the only
route to the underlying `NSMenuItem` — is `pub(crate)` in Tauri, so the flag cannot be set after
the fact either.

So the glyphs are drawn twice, near-black and near-white, and `build_tray_menu(app, dark, …)`
picks a set. `WindowEvent::ThemeChanged` rebuilds the whole menu when the user switches
appearance, because muda also offers no way to swap an item's image in place.

The one thing this still cannot do is invert over a highlighted (blue) row. Black-on-blue stays
legible, so it is left alone.

If muda ever marks these as template images, collapse this to one black set and delete the
rebuild-on-theme-change branch.

## Two details worth keeping

**The alpha is 224, not 255.** That is macOS `labelColor`, the colour the menu text beside these
is drawn in. A fully opaque glyph sits visibly heavier than its own label.

**36×36 is deliberate.** muda scales menu images to 18 points high; supplying twice that keeps
them crisp on Retina displays. Larger buys nothing, smaller looks soft.

## Two drawing decisions

Settings uses three sliders rather than a gear: a gear's teeth alias into mush at 18pt, and the
slider glyph is what macOS itself uses for the same idea.

`Launch at Startup` has no icon on purpose: it is a check item, which already owns the state
column, and muda has no item type that carries both a checkmark and an image.
