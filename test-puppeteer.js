const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteerExtra.use(StealthPlugin());

async function runTest() {
  console.log('Starting Puppeteer validation test...');
  let browser;
  try {
    console.log('Launching browser (headless: true)...');
    browser = await puppeteerExtra.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    console.log('Opening new page...');
    const page = await browser.newPage();
    
    console.log('Navigating to check public IP...');
    await page.goto('https://api.ipify.org?format=json', { waitUntil: 'networkidle2' });
    const ipContent = await page.evaluate(() => document.body.innerText);
    console.log('Page output (IP Info):', ipContent);
    
    console.log('Navigating to YouTube...');
    await page.goto('https://www.youtube.com', { waitUntil: 'networkidle2' });
    
    const title = await page.title();
    console.log('Page Title:', title);
    
    const screenshotPath = path.join(__dirname, 'test_screenshot.png');
    console.log(`Taking screenshot: ${screenshotPath}`);
    await page.screenshot({ path: screenshotPath });
    
    console.log('✅ Puppeteer, Puppeteer-Extra, and Stealth Plugin are working perfectly!');
  } catch (error) {
    console.error('❌ Puppeteer test failed with error:', error.message);
  } finally {
    if (browser) {
      await browser.close();
      console.log('Browser closed.');
    }
  }
}

runTest();
