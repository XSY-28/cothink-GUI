const navigation = page => page.getByRole("navigation", { name: "工作导航" });
export const railButton = (page, name) => navigation(page).getByRole("button", { name, exact: true });
export async function chooseRailCreation(page, name) {
  await railButton(page, "新建").click();
  await page.getByRole("button", { name, exact: true }).click();
}

export async function finishFirstRoster(page, name) {
  const dialog = page.getByRole("dialog", { name: "配置阵容", exact: true });
  await dialog.getByRole("button", { name: `选择 ${name}`, exact: true }).click();
  await dialog.getByRole("button", { name: "开始对话", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}
