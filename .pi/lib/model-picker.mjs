import { Container, Input, SelectList, Text, fuzzyFilter } from "@earendil-works/pi-tui";

// Core's generic ui.select renders every option. Model catalogs need a bounded
// list so keyboard navigation stays visible even in a small phone terminal.
export async function selectModel(ctx, title, choices, selected) {
	const items = [...new Set(choices)].map((value) => ({ value, label: value }));
	if (typeof ctx.ui.selectModel === "function") return ctx.ui.selectModel(title, items.map((item) => item.value), selected);
	return await ctx.ui.custom((tui, theme, keys, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", title), 0, 0));
		const input = new Input({ prompt: "Search: " }); input.focused = true;
		container.addChild(input);
		const listTheme = {
			selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text), scrollInfo: (text) => theme.fg("dim", text), noMatch: (text) => theme.fg("warning", text),
		};
		const listContainer = new Container(); container.addChild(listContainer);
		let list;
		const update = (query) => {
			const filtered = fuzzyFilter(items, query, (item) => item.value);
			list = new SelectList(filtered, Math.max(1, Math.min(7, tui.terminal.rows - 12)), listTheme);
			if (!query) list.setSelectedIndex(Math.max(0, filtered.findIndex((item) => item.value === selected)));
			list.onSelect = (item) => done(item.value); list.onCancel = () => done(undefined);
			listContainer.clear(); listContainer.addChild(list);
		};
		update("");
		container.addChild(new Text(theme.fg("dim", "Type to search · ↑↓ select · Enter apply · Esc back"), 0, 0));
		return {
			render(width) { return container.render(width); }, invalidate() { container.invalidate(); },
			handleInput(data) {
				if (["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"].some((key) => keys.matches(data, key))) list.handleInput(data);
				else { input.handleInput(data); update(input.getValue()); }
				tui.requestRender();
			},
		};
	});
}
