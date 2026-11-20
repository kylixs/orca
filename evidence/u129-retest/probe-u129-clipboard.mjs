#!/usr/bin/env node
// Focused U129 check: cross-origin embed grants clipboard-write to the frame.
import { chromium } from 'playwright'
import fs from 'node:fs'
const BASE = 'https://127.0.0.1:18788'
const PROJECT = 'proj_fd19e4ff'
const out = { base: BASE, project: PROJECT, steps: {} }
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write']
})
const page = await ctx.newPage()
page.setDefaultTimeout(60000)
page.on('console', (m) => {
  if (m.type() === 'error') (out.errors ??= []).push(m.text().slice(0, 300))
})
try {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.locator('#loginForm').waitFor({ timeout: 30000 })
  await page.fill('#username', 'zhangsan')
  await page.fill('#password', 'Passw0rd!')
  await page.click('#loginBtn')
  await page.locator('#view-app').waitFor({ timeout: 30000 })
  await page.goto(BASE + '/#/workspace/' + PROJECT, { waitUntil: 'domcontentloaded' })
  const frameEl = page.locator('iframe.workspace-frame').first()
  await frameEl.waitFor({ state: 'attached', timeout: 60000 })
  out.steps.iframeAllow = await frameEl.getAttribute('allow')
  const frame = page
    .frames()
    .find((f) => f !== page.mainFrame() && f.url().includes('cloud-admin.html'))
  out.steps.iframeUrl = frame?.url().slice(0, 200) ?? null
  await frame.waitForLoadState('domcontentloaded')
  out.steps.delegationSupported = await frame
    .evaluate(() =>
      !!navigator.permissions && document.featurePolicy
        ? document.featurePolicy.allowsFeature('clipboard-write')
        : 'no-feature-policy-api'
    )
    .catch((e) => String(e).slice(0, 200))
  await frame.evaluate(() => {
    const b = document.createElement('button')
    b.id = 'u129-test-btn'
    b.textContent = 'copy'
    b.onclick = () => {
      window.__u129 = 'pending'
      navigator.clipboard.writeText('u129-retest-payload').then(
        () => {
          window.__u129 = 'ok'
        },
        (e) => {
          window.__u129 = 'error: ' + e
        }
      )
    }
    document.body.appendChild(b)
  })
  await frame.locator('#u129-test-btn').click()
  await new Promise((r) => setTimeout(r, 500))
  out.steps.write = await frame.evaluate(() => window.__u129)
  out.steps.frameClipboardLength = await frame
    .evaluate(() =>
      navigator.clipboard
        .readText()
        .then((t) => t.length)
        .catch(() => null)
    )
    .catch(() => null)
  out.steps.pageClipboardText = await page
    .evaluate(() =>
      navigator.clipboard
        .readText()
        .then((t) => t.slice(0, 40))
        .catch(() => null)
    )
    .catch(() => null)
  await page.screenshot({ path: 'evidence/u129-retest/probe-u129-clipboard.png' })
} catch (e) {
  out.error = String(e).slice(0, 1200)
} finally {
  fs.writeFileSync('evidence/u129-retest/probe-u129-clipboard.json', JSON.stringify(out, null, 2))
  await browser.close()
}
console.log(JSON.stringify(out, null, 2))
