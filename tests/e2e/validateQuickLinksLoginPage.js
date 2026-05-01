require("dotenv").config();
import { Selector } from "testcafe";

// Run from c:\Git-Repositories\blt-e2e so dotenv picks up blt-e2e/.env
const tenantURL = process.env.TEST_TENANT_URL || "";

const quickLinksButton = Selector("button").withText("Quick Links");
const validateQuickLinks = true;

fixture`React Sites`.page(tenantURL);

test('Validate Quick Links on the login page for react sites.', async (t) => {
    await t.click(Selector("span").withText("Help"));
    await t.click(quickLinksButton);
    await t.expect(Selector('nav[aria-label="Main Navbar"]').visible).ok('Top navbar not found — page did not load');
    await t.expect(Selector('button[aria-label="button-Dashboard"]').visible).ok('Sidebar Dashboard button not found — sidebar did not load');
});
