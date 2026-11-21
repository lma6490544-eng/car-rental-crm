// Ant motion's prepare frame is visible before its zero-height start frame.
// Observe the active popup after opening completes, then assert one DOM snapshot.
async function selectOptionsSnapshot(page, expectedCount) {
  let handle;
  try {
    handle = await page.waitForFunction((expectedCount) => {
      // rc-select uses duplicate TEST_OR_SSR list IDs in this test environment.
      // Keep the existing visible-popup scope instead of resolving aria-controls.
      const dropdown = Array.from(document.querySelectorAll('.ant-select-dropdown'))
        .filter((element) => {
          const bounds = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            bounds.width > 0 &&
            bounds.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none'
          );
        })
        .at(-1);
      if (!dropdown) return false;
      const bounds = dropdown.getBoundingClientRect();
      const style = getComputedStyle(dropdown);
      const moving = Array.from(dropdown.classList).some((name) =>
        /^ant-slide-up-(appear|enter|leave)(-|$)/.test(name),
      );
      if (
        !bounds.width ||
        !bounds.height ||
        style.visibility === 'hidden' ||
        style.display === 'none' ||
        moving
      )
        return false;
      const options = Array.from(dropdown.querySelectorAll('.ant-select-item-option'));
      if (!options.length || (expectedCount !== undefined && options.length !== expectedCount))
        return false;
      return {
        count: options.length,
        enabledCount: options.filter(
          (option) => !option.classList.contains('ant-select-item-option-disabled'),
        ).length,
      };
    }, expectedCount);
  } catch (error) {
    const state = await page.evaluate(() => ({
      active: {
        label: document.activeElement?.getAttribute('aria-label'),
        role: document.activeElement?.getAttribute('role'),
        expanded: document.activeElement?.getAttribute('aria-expanded'),
        controls: document.activeElement?.getAttribute('aria-controls'),
      },
      dropdowns: Array.from(document.querySelectorAll('.ant-select-dropdown')).map((el) => ({
        classes: el.className,
        display: getComputedStyle(el).display,
        height: el.getBoundingClientRect().height,
        options: el.querySelectorAll('.ant-select-item-option').length,
        ids: Array.from(el.querySelectorAll('[id]')).map((e) => e.id),
      })),
    }));
    error.message += '\nSelect state: ' + JSON.stringify(state);
    error.stack += '\nSelect state: ' + JSON.stringify(state);
    throw error;
  }
  try {
    return await handle.jsonValue();
  } finally {
    await handle.dispose();
  }
}
module.exports = { selectOptionsSnapshot };
