const navigation = page => page.getByRole("navigation", { name: "工作导航" });
export const railButton = (page, name) => navigation(page).getByRole("button", { name, exact: true });
export async function chooseRailCreation(page, name) {
  await railButton(page, "新建").click();
  await page.getByRole("button", { name, exact: true }).click();
}
