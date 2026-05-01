Run all three accessibility test suites for the blt-e2e project sequentially. Use the following commands one at a time, reporting pass/fail results after each:

1. `npx testcafe chrome tests/a11y/businessCenterA11y.js -S -s takeOnFails=true,path=./artifacts/screenshots --assertion-timeout 30000 --skip-js-errors --page-request-timeout 30000`
2. `npx testcafe chrome tests/a11y/registrationA11y.js -S -s takeOnFails=true,path=./artifacts/screenshots --assertion-timeout 30000 --skip-js-errors --page-request-timeout 30000`
3. `npx testcafe chrome tests/a11y/editBusinessA11y.js -S -s takeOnFails=true,path=./artifacts/screenshots --assertion-timeout 30000 --skip-js-errors --page-request-timeout 30000`

After all three complete, provide a summary table showing each suite name, number passed, number failed, and the specific violations found in any failures.
