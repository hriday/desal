import { expect, test } from '@playwright/test';

// One run against the live stack (Kafka, simulator, gateway, vite preview). It starts exactly one
// game: the gateway allows one newGame per 10 s per client.
test('play a shift end to end', async ({ page }) => {
  await page.goto('/');

  // 1. Start a run and start shift 1 in Auto.
  await page.getByRole('button', { name: 'Start a run' }).click();
  await expect(page.locator('[data-screen="handover"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('radio', { name: /^Auto/ })).toBeChecked();
  await page.getByRole('button', { name: 'Start shift 1' }).click();
  const room = page.locator('[data-screen="room"]');
  await expect(room).toBeVisible({ timeout: 20_000 });

  // 2. The wall: six monitors and a live TBT reading.
  await expect(page.locator('[data-monitor]')).toHaveCount(6);
  await expect(page.locator('[data-monitor="heater"]')).toContainText(/TBT \d+(\.\d+)? °C/, { timeout: 15_000 });

  // 3. Open Flash Stages, close it with Esc.
  await page.locator('[data-monitor="stages"]').click();
  await expect(page.locator('[data-expanded="stages"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-expanded]')).toHaveCount(0);
  await expect(page.locator('[data-monitor]')).toHaveCount(6);
  await page.screenshot({ path: process.env.E2E_SCREENSHOT ?? 'test-results/live-room.png' });

  // 4. Raise the TBT setpoint and see the plant report the new value.
  await page.locator('[data-monitor="heater"]').click();
  const ctl = page.locator('[data-control="TBT setpoint"]');
  await expect(ctl).toContainText(/reported \d+\.\d °C/);
  const before = Number(/reported (\d+\.\d) °C/.exec((await ctl.textContent()) ?? '')![1]);
  const after = (before + 0.5).toFixed(1);
  await page.getByRole('button', { name: 'Increase TBT setpoint' }).click();
  await page.getByRole('button', { name: 'Set TBT setpoint' }).click();
  await expect(ctl).toContainText(`reported ${after} °C`, { timeout: 10_000 });
  await expect(ctl).not.toContainText('sending…');
  await page.keyboard.press('Escape');

  // 5. Reload: back in the same game.
  const gameId = await room.getAttribute('data-game-id');
  expect(gameId).toMatch(/^[0-9a-f-]{36}$/);
  await page.reload();
  await expect(room).toBeVisible({ timeout: 20_000 });
  await expect(room).toHaveAttribute('data-game-id', gameId!);

  // 6. Quit (with confirmation) and see the game-over screen.
  await page.getByRole('button', { name: 'Quit run' }).click();
  await page.getByRole('button', { name: 'Yes, quit' }).click();
  await expect(page.locator('[data-screen="over"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-screen="over"]')).toContainText('You ended the run');
});
