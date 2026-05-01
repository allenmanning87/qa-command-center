require("dotenv").config();
import { Selector } from "testcafe";

// Run from c:\Git-Repositories\blt-e2e so dotenv picks up blt-e2e/.env
const tenantURL = process.env.TEST_TENANT_URL || "";

fixture`React Site: Pre-Login Terms of Use`.page(`${tenantURL}/login`);

test("Terms of Use link is visible on login page with correct href", async (t) => {
  // aria-label is platform-specific and must match the value rendered by the platform
  const termsLink = Selector("a[aria-label='Terms of Use Govos']");
  await t.expect(termsLink.visible).ok("Terms of Use link not visible on login page");

  const href = await termsLink.getAttribute("href");
  await t.expect(href).contains("terms", "Terms of Use link href does not point to a terms page");
});

//needs filter flag added