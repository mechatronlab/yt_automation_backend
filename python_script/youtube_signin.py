from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.keys import Keys
import sys
import time
import os
import json
import re
import tempfile
import shutil

from selenium.common.exceptions import (
    StaleElementReferenceException,
    TimeoutException,
    NoSuchWindowException,
    WebDriverException,
    InvalidSessionIdException,
)

from fivesim_api_handler import FiveSimAPIHandler


PHONE_FIRST_SIGNUP_ATTEMPTS = (
    {
        'name': 'webcreateaccount-desktop',
        'mobile': False,
        'url': (
            'https://accounts.google.com/signup/v2/webcreateaccount'
            '?flowEntry=SignUp&flowName=GlifWebSignIn&hl=en'
        ),
    },
    {
        # Desktop retry with alternate entry URL (mobile emulation often triggers
        # outbound "Send SMS" / QR checks that virtual numbers cannot pass).
        'name': 'signup-desktop',
        'mobile': False,
        'url': (
            'https://accounts.google.com/signup'
            '?hl=en&flowEntry=SignUp&flowName=GlifWebSignIn'
        ),
    },
    {
        'name': 'webcreateaccount-mobile',
        'mobile': True,
        'url': (
            'https://accounts.google.com/signup/v2/webcreateaccount'
            '?flowEntry=SignUp&flowName=GlifWebSignIn&hl=en'
        ),
    },
)


def read_first_line(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.readline().strip()


def detect_gmail_from_page(driver):
    """Try to extract the new Gmail address from the current page."""
    source = driver.page_source or ""
    match = re.search(r'[\w.+-]+@gmail\.com', source, re.IGNORECASE)
    if match:
        return match.group(0).lower()
    try:
        for selector in ('input[type="email"]', '[data-email]', '[aria-label*="@"]'):
            for el in driver.find_elements(By.CSS_SELECTOR, selector):
                val = (el.get_attribute('value') or el.get_attribute('data-email') or el.text or '').strip()
                if '@gmail.com' in val.lower():
                    return val.lower()
    except Exception:
        pass
    return ''


def save_created_account(base_dir, account_data):
    account_data['completed'] = True
    with open(os.path.join(base_dir, 'last_created_account.json'), 'w', encoding='utf-8') as f:
        json.dump(account_data, f, indent=2)


def save_partial_account(base_dir, account_data):
    account_data['completed'] = False
    account_data['status'] = 'pending'
    with open(os.path.join(base_dir, 'last_created_account.json'), 'w', encoding='utf-8') as f:
        json.dump(account_data, f, indent=2)
    phone = account_data.get('phone', '')
    first = account_data.get('firstName', '')
    last = account_data.get('lastName', '')
    email = account_data.get('email', '')
    print(
        f'ACCOUNT_PARTIAL firstName={first} lastName={last} phone={phone} '
        f'email={email} password={account_data.get("password", "")}'
    )


def emit_partial_and_exit(base_dir, account_data, message):
    save_partial_account(base_dir, account_data)
    print(message)
    sys.exit(1)


def driver_alive(driver):
    try:
        _ = driver.current_url
        return True
    except (NoSuchWindowException, InvalidSessionIdException, WebDriverException):
        return False


def safe_click_el(driver, element):
    """Native click only — JS clicks crash Chrome 150 on some Mac builds."""
    if not driver_alive(driver):
        raise NoSuchWindowException('Browser window already closed')
    try:
        element.click()
        return
    except WebDriverException:
        pass
    # Last resort: ActionChains move + click (still no execute_script click)
    ActionChains(driver).move_to_element(element).pause(0.1).click().perform()


def js_click_el(driver, element):
    safe_click_el(driver, element)


def click_element_with_text(driver, *needles):
    if not driver_alive(driver):
        print('ERROR: Browser window closed before click')
        return False
    needles_l = [n.lower() for n in needles]
    try:
        elements = driver.find_elements(
            By.XPATH,
            "//button | //a | //div[@role='button'] | //span[@role='link'] | //li[@role='option']",
        )
    except (NoSuchWindowException, InvalidSessionIdException) as exc:
        print(f'ERROR: Browser unavailable while searching click targets: {exc}')
        return False
    except WebDriverException as exc:
        print(f'ERROR: Browser unavailable while searching click targets: {exc}')
        return False

    for el in elements:
        try:
            if not el.is_displayed():
                continue
            text = (el.text or el.get_attribute('aria-label') or '').strip().lower()
            if any(n in text for n in needles_l):
                safe_click_el(driver, el)
                return True
        except (NoSuchWindowException, InvalidSessionIdException) as exc:
            print(f'ERROR: Browser closed during click: {exc}')
            return False
        except Exception:
            continue
    return False


def click_next_button(driver):
    if not driver_alive(driver):
        print('ERROR: Browser window closed before Next')
        return False
    selectors = [
        "#createpasswordNext button",
        "#usernameNext button",
        "#collectEmailPhoneNext button",
        "#birthdaygenderNext button",
        "#collectNameNext button",
        "#next button",
        "button[jsname='LgbsSe']",
    ]
    for css in selectors:
        try:
            btn = WebDriverWait(driver, 2).until(
                EC.element_to_be_clickable((By.CSS_SELECTOR, css))
            )
            safe_click_el(driver, btn)
            return True
        except (NoSuchWindowException, InvalidSessionIdException) as exc:
            print(f'ERROR: Browser closed on Next click: {exc}')
            return False
        except WebDriverException:
            continue
        except Exception:
            continue
    # Text fallback — avoid scanning the whole DOM with JS clicks
    try:
        for el in driver.find_elements(By.XPATH, "//button"):
            if not el.is_displayed():
                continue
            text = (el.text or el.get_attribute('aria-label') or '').strip().lower()
            if text in ('next', 'continue', 'done') or text.startswith('next'):
                safe_click_el(driver, el)
                return True
    except (NoSuchWindowException, InvalidSessionIdException) as exc:
        print(f'ERROR: Browser closed on Next fallback: {exc}')
        return False
    except WebDriverException:
        return False
    return False


def submit_with_enter(driver, element=None):
    """Submit current form via Enter — more stable than clicking Next on Google pages."""
    try:
        target = element
        if target is None:
            target = driver.switch_to.active_element
        target.send_keys(Keys.ENTER)
        return True
    except (NoSuchWindowException, InvalidSessionIdException):
        raise
    except WebDriverException as exc:
        print(f'Enter submit note: {exc}')
        return False


def is_outbound_sms_verification(driver):
    """Google asks the device to SEND an SMS — virtual numbers cannot do this."""
    try:
        page = (driver.page_source or '').lower()
        url = (driver.current_url or '').lower()
    except Exception:
        return False
    return (
        'your phone will open an sms message with a code you need to send' in page
        or (
            'send sms' in page
            and 'verify your phone number' in page
            and 'code you need to send' in page
        )
        or ('startphoneverification' in url and 'send sms' in page)
    )


def is_qr_verification_page(driver):
    try:
        url = driver.current_url.lower()
        page = driver.page_source.lower()
    except Exception:
        return False
    if is_outbound_sms_verification(driver):
        return True
    if 'mophoneverification' in url or 'qrcod' in url:
        return True
    qr_phrases = (
        'verify some info before creating',
        'scan the qr code with your phone',
        'scan the qr code',
        'scan the code with your phone',
        'open your camera app, scan the code',
    )
    return any(phrase in page for phrase in qr_phrases)


def switch_qr_to_phone_entry(driver):
    """Try to switch QR verification page to manual phone/SMS entry."""
    for label in (
        'Try another way',
        'Try a different way',
        'Get a verification code',
        'Get a verification code sent to your phone',
        'Text message',
        'SMS',
        'Use your phone number',
        'Use your mobile phone',
        'Enter phone number',
        'More options',
    ):
        if click_element_with_text(driver, label):
            print(f'QR page: clicked "{label}"')
            time.sleep(2)
            if find_phone_field(driver) or is_sms_code_step(driver):
                return True
    return False


def is_password_step(driver):
    """Detect Google's password creation step (must win over username SPA leftovers)."""
    try:
        url = (driver.current_url or '').lower()
        page = (driver.page_source or '').lower()
    except Exception:
        return False
    # Never treat the Gmail username picker as password (SPA often preloads fields).
    if 'signup/username' in url:
        return False
    if 'signup/password' in url or '/password' in url:
        return True
    if 'create a strong password' in page or 'confirm your password' in page:
        return True
    for sel in (
        '#passwd input',
        'input[name="Passwd"]',
        '#Passwd input',
        '#confirm-passwd input',
        'input[name="PasswdAgain"]',
        'input[name="ConfirmPasswd"]',
    ):
        try:
            if any(el.is_displayed() for el in driver.find_elements(By.CSS_SELECTOR, sel)):
                return True
        except Exception:
            continue
    return False


def is_username_step(driver):
    if is_qr_verification_page(driver):
        return False
    # Password page can still contain leftover "create a gmail address" text in the SPA.
    if is_password_step(driver):
        return False
    try:
        page = driver.page_source.lower()
        url = driver.current_url.lower()
    except Exception:
        return False
    has_username_ui = bool(
        driver.find_elements(By.CSS_SELECTOR, '#username, input[name="Username"], input[aria-label*="Username"]')
    )
    has_gmail_radio = bool(
        driver.find_elements(
            By.XPATH,
            "//div[@role='radio' and contains(., '@gmail.com')]",
        )
    )
    has_gmail_choice = any(
        phrase in page
        for phrase in (
            'choose your gmail address',
            'create your own gmail address',
            'create a gmail address',
            'create an email address',
            'how you\'ll sign in',
            'pick a gmail address',
        )
    )
    if has_username_ui or has_gmail_radio or has_gmail_choice:
        return True
    return 'signuptypeselector' in url or 'signup/username' in url


def is_optional_email_step(driver):
    url = driver.current_url.lower()
    return 'optionalemail' in url or 'recoveryemail' in url


def is_sms_code_step(driver):
    try:
        return bool(driver.find_elements(By.CSS_SELECTOR, '#code, input[name="code"]'))
    except Exception:
        return False


def _pick_suggested_gmail_radio(driver):
    """Click the first suggested @gmail.com radio and press Next. Returns email or ''."""
    # Wait briefly for Google to render suggestions
    try:
        WebDriverWait(driver, 8).until(
            lambda d: d.find_elements(
                By.XPATH,
                "//div[@role='radio' and contains(., '@gmail.com')]"
                " | //*[contains(text(), '@gmail.com')]",
            )
        )
    except TimeoutException:
        print('No @gmail.com suggestions appeared within timeout')
        return ''
    except (NoSuchWindowException, InvalidSessionIdException, WebDriverException):
        raise

    xpaths = (
        "//div[@role='radio' and contains(., '@gmail.com')]",
        "//label[contains(., '@gmail.com')]",
        "//li[@role='option' and contains(., '@gmail.com')]",
        "//*[contains(text(), '@gmail.com')]/ancestor::div[@role='radio'][1]",
    )
    for xpath in xpaths:
        try:
            options = [
                el for el in driver.find_elements(By.XPATH, xpath)
                if el.is_displayed()
            ]
            for option in options:
                text = (option.text or option.get_attribute('aria-label') or '').strip()
                match = re.search(r'[\w.+-]+@gmail\.com', text, re.I)
                if not match:
                    data_email = (option.get_attribute('data-email') or '').strip()
                    match = re.search(r'[\w.+-]+@gmail\.com', data_email, re.I)
                if not match:
                    continue
                selected = match.group(0).lower()
                safe_click_el(driver, option)
                print(f'Selected suggested Gmail: {selected}')
                time.sleep(0.8)
                # Prefer Enter / usernameNext — avoid flaky multi-selector Next scans
                advanced = False
                try:
                    advanced = submit_with_enter(driver, option)
                except WebDriverException:
                    advanced = False
                if not advanced:
                    advanced = click_next_button(driver)
                if not advanced:
                    continue
                try:
                    WebDriverWait(driver, 12).until(
                        lambda d: is_password_step(d) or find_phone_field(d) or is_sms_code_step(d)
                        or ('username' not in (d.current_url or '').lower())
                    )
                except TimeoutException:
                    print('Still on username page after Next — trying next option')
                    continue
                print(f'Left username step after selecting {selected}')
                return selected
        except (NoSuchWindowException, InvalidSessionIdException):
            raise
        except WebDriverException as exc:
            # Empty-message crashes often mean the tab died mid-click
            if not driver_alive(driver):
                raise
            print(f'Gmail radio click note: {exc.__class__.__name__}: {exc}')
            continue
        except Exception:
            continue
    return ''


def handle_username_step(driver, first_name, last_name):
    """Select a Gmail address. Returns selected email or empty string.

    Returns '__password_reached__' if the flow already advanced to password
    (so the caller can fill password without treating this as failure).
    """
    if not driver_alive(driver):
        print('ERROR: Browser closed before Gmail username step')
        return ''
    if is_outbound_sms_verification(driver):
        print('ERROR: Google requires outbound Send SMS (virtual numbers cannot do this)')
        return ''
    if is_qr_verification_page(driver) and not is_password_step(driver):
        return ''

    # Crash screenshot previously showed password page while we still thought
    # we were on username — recover instead of poking radio XPaths.
    if is_password_step(driver):
        email = extract_selected_gmail(driver)
        print(f'Already on password step during username handler. email={email or "unknown"}')
        return email or '__password_reached__'

    print('Handling Gmail username step...')
    try:
        driver.save_screenshot('username_step.png')
        time.sleep(0.8)
        log_visible_actions(driver)

        if is_password_step(driver):
            email = extract_selected_gmail(driver)
            print(f'Navigated to password before selection. email={email or "unknown"}')
            return email or '__password_reached__'

        selected = _pick_suggested_gmail_radio(driver)
        if selected:
            return selected

        if is_password_step(driver):
            return extract_selected_gmail(driver) or '__password_reached__'

        # Fallback: create your own username
        click_element_with_text(
            driver,
            'create your own gmail address',
            'create a gmail address',
            'create gmail address',
        )
        time.sleep(1)

        username_base = re.sub(r'[^a-z0-9]', '', f'{first_name}{last_name}'.lower())[:20] or 'user'
        username = f'{username_base}{int(time.time()) % 100000}'

        for sel in (
            '#username',
            'input[name="Username"]',
            'input[aria-label*="Username"]',
            'input[aria-label*="Gmail address"]',
            'input[type="email"]',
        ):
            try:
                field = WebDriverWait(driver, 6).until(
                    EC.element_to_be_clickable((By.CSS_SELECTOR, sel))
                )
                field.click()
                time.sleep(0.2)
                field.clear()
                field.send_keys(username)
                selected = f'{username}@gmail.com'
                print(f'Entered custom username: {username}')
                time.sleep(0.5)
                if click_next_button(driver):
                    time.sleep(2)
                    return selected
            except (NoSuchWindowException, InvalidSessionIdException, WebDriverException):
                raise
            except Exception:
                continue

        if is_password_step(driver):
            return extract_selected_gmail(driver) or '__password_reached__'

        if click_next_button(driver):
            time.sleep(2)
            if is_password_step(driver):
                return extract_selected_gmail(driver) or '__password_reached__'
            return extract_selected_gmail(driver)
        return ''
    except (NoSuchWindowException, InvalidSessionIdException, WebDriverException) as exc:
        # If Chrome died after advancing, surface that clearly
        print(f'ERROR: Browser closed during Gmail username step: {exc}')
        return ''


def fill_password_step(driver, password):
    """Fill password + confirm on Google's password step."""
    print('Handling password step...')
    if not driver_alive(driver):
        print('ERROR: Browser closed before password step')
        return False

    passwd_field = None
    confirm_field = None

    for sel in ('#passwd input', 'input[name="Passwd"]', '#Passwd input', 'input[type="password"]'):
        try:
            els = [el for el in driver.find_elements(By.CSS_SELECTOR, sel) if el.is_displayed()]
            if els:
                passwd_field = els[0]
                if len(els) > 1 and sel == 'input[type="password"]':
                    confirm_field = els[1]
                break
        except Exception:
            continue

    if not passwd_field:
        try:
            passwd_field = WebDriverWait(driver, 10).until(
                EC.element_to_be_clickable((By.CSS_SELECTOR, 'input[type="password"]'))
            )
        except Exception:
            pass

    if not passwd_field:
        driver.save_screenshot('password_field_missing.png')
        print('ERROR: Could not find password field')
        return False

    try:
        passwd_field.click()
        time.sleep(0.2)
        # Clear via keys — .clear() is flaky on Google Material inputs
        select_all = Keys.COMMAND if sys.platform == 'darwin' else Keys.CONTROL
        passwd_field.send_keys(select_all, 'a')
        passwd_field.send_keys(Keys.DELETE)
        passwd_field.send_keys(password)
        typed = passwd_field.get_attribute('value')
        # Google often hides password values from the DOM — None/'' is normal
        if typed is not None and len(typed) > 0:
            print(f'Password typed (len={len(typed)})')
        else:
            print('Password keys sent (value hidden by page)')
            typed = password  # assume OK; Material inputs often don't expose value
        if typed is not None and 0 < len(typed) < 8:
            # Retry with ActionChains char-by-char
            passwd_field.click()
            passwd_field.send_keys(select_all, 'a')
            passwd_field.send_keys(Keys.DELETE)
            for ch in password:
                passwd_field.send_keys(ch)
                time.sleep(0.03)
            print('Password retyped (short value detected)')
    except (NoSuchWindowException, InvalidSessionIdException):
        raise
    except WebDriverException as exc:
        print(f'ERROR: Could not type password: {exc}')
        return False

    if not confirm_field:
        for sel in ('#confirm-passwd input', 'input[name="PasswdAgain"]', 'input[name="ConfirmPasswd"]'):
            try:
                confirm = driver.find_element(By.CSS_SELECTOR, sel)
                if confirm.is_displayed():
                    confirm_field = confirm
                    break
            except Exception:
                continue
        if not confirm_field:
            pw_inputs = [
                el for el in driver.find_elements(By.CSS_SELECTOR, 'input[type="password"]')
                if el.is_displayed()
            ]
            if len(pw_inputs) > 1:
                confirm_field = pw_inputs[1]

    if confirm_field:
        try:
            confirm_field.click()
            select_all = Keys.COMMAND if sys.platform == 'darwin' else Keys.CONTROL
            confirm_field.send_keys(select_all, 'a')
            confirm_field.send_keys(Keys.DELETE)
            confirm_field.send_keys(password)
            print('Confirm password typed')
        except WebDriverException as exc:
            print(f'Confirm password note: {exc}')

    driver.save_screenshot('password_filled.png')

    # Prefer Enter on confirm/password field — avoids Chrome crash on Next button click
    submit_target = confirm_field or passwd_field
    if submit_with_enter(driver, submit_target):
        time.sleep(2)
        if not is_password_step(driver) or 'password' not in (driver.current_url or '').lower():
            driver.save_screenshot('after_password.png')
            print('Password submitted via Enter')
            return True
        print('Still on password after Enter — trying Next button')

    if not click_next_button(driver):
        print('ERROR: Could not submit password step')
        return False

    time.sleep(2)
    driver.save_screenshot('after_password.png')
    print('Password submitted')
    return True


def extract_selected_gmail(driver):
    email = detect_gmail_from_page(driver)
    if email:
        return email
    for el in driver.find_elements(By.XPATH, "//*[contains(text(), '@gmail.com')]"):
        try:
            text = (el.text or el.get_attribute('data-email') or '').strip().lower()
            match = re.search(r'[\w.+-]+@gmail\.com', text)
            if match:
                return match.group(0)
        except Exception:
            continue
    return ''


def is_gmail_picker_page(driver):
    """True when Google is asking to pick/create a @gmail.com address."""
    url = driver.current_url.lower()
    if 'signup/username' in url:
        return True
    page = (driver.page_source or '').lower()
    return any(
        phrase in page
        for phrase in (
            'create an email address',
            'create a gmail address',
            'choose your gmail address',
            'pick a gmail address',
        )
    )


def find_phone_field(driver):
    if is_gmail_picker_page(driver):
        return None
    selectors = [
        (By.ID, 'emailPhone'),
        (By.ID, 'phoneNumberId'),
        (By.CSS_SELECTOR, 'input[type="tel"]'),
        (By.CSS_SELECTOR, 'input[name="phoneNumber"]'),
        (By.CSS_SELECTOR, 'input[name="phoneNumberId"]'),
        (By.CSS_SELECTOR, 'input[autocomplete="tel"]'),
        (By.XPATH, '//input[contains(@aria-label,"phone") or contains(@aria-label,"Phone")]'),
    ]
    for by, value in selectors:
        try:
            for el in driver.find_elements(by, value):
                field_id = (el.get_attribute('id') or '').lower()
                field_name = (el.get_attribute('name') or '').lower()
                if field_id == 'username' or field_name == 'username':
                    continue
                if el.is_displayed() and el.is_enabled():
                    return el
        except Exception:
            continue
    return None


def type_into_phone_field(driver, phone_number, retries=3):
    for attempt in range(1, retries + 1):
        try:
            field = find_phone_field(driver)
            if not field:
                return False
            field.click()
            time.sleep(0.2)
            field.clear()
            time.sleep(0.2)
            field.send_keys(phone_number)
            return True
        except StaleElementReferenceException:
            print(f'Stale phone field (attempt {attempt}), retrying...')
            time.sleep(0.5)
        except Exception as exc:
            print(f'Phone field error (attempt {attempt}): {exc}')
            time.sleep(0.5)
    return False


def is_collect_email_phone_step(driver):
    """Combined step where Google accepts phone OR email in one field (#emailPhone)."""
    url = driver.current_url.lower()
    if any(token in url for token in ('collectemailphone', 'emailphone', 'startmtsmsidv')):
        return True
    if find_phone_field(driver):
        return True
    page = driver.page_source.lower()
    return any(
        phrase in page
        for phrase in (
            'how you\'ll sign in',
            'use your email or phone',
            'email or phone number',
            'phone number or email',
        )
    )


def log_visible_actions(driver):
    """Debug helper — print clickable labels on the current page."""
    print('Visible buttons/links on page:')
    for el in driver.find_elements(
        By.XPATH,
        "//button | //a | //div[@role='button'] | //span[@role='link'] | //li[@role='option']",
    ):
        try:
            if not el.is_displayed():
                continue
            text = (el.text or el.get_attribute('aria-label') or '').strip()
            if text:
                print(f'  • {text[:120]}')
        except Exception:
            continue


def try_skip_email_use_phone(driver):
    """On email/username pages, click links to use phone number instead of Gmail."""
    print('Trying to skip email step — use phone number instead...')
    for label in (
        'use phone number',
        'use your phone',
        'phone number instead',
        'sign up with phone',
        'verify with phone',
        'use a phone number',
        'get a verification code',
        'text message',
        'try another way',
        'use mobile phone',
        'add phone number',
        'verify your phone',
        'use phone',
    ):
        if click_element_with_text(driver, label):
            print(f'Clicked "{label}"')
            time.sleep(2)
            if find_phone_field(driver) or is_sms_code_step(driver):
                return True

    for el in driver.find_elements(
        By.XPATH,
        "//a[contains(translate(., 'PHONE', 'phone'), 'phone')]"
        " | //button[contains(translate(., 'PHONE', 'phone'), 'phone')]"
        " | //div[@role='button'][contains(translate(., 'PHONE', 'phone'), 'phone')]",
    ):
        try:
            if el.is_displayed():
                js_click_el(driver, el)
                print('Clicked phone-related link:', (el.text or el.get_attribute('aria-label') or '')[:80])
                time.sleep(2)
                if find_phone_field(driver) or is_sms_code_step(driver):
                    return True
        except Exception:
            continue
    return False


def wait_for_email_phone_field(driver, timeout=25):
    """Original flow: wait for #emailPhone after birthday before any other step."""
    print(f'Waiting up to {timeout}s for #emailPhone (phone-first signup)...')
    deadline = time.time() + timeout
    while time.time() < deadline:
        url = driver.current_url.lower()
        if 'username' in url or is_gmail_picker_page(driver):
            print('Detected Gmail username page (not phone-first)')
            return 'username'
        if is_password_step(driver):
            return 'password'
        if is_qr_verification_page(driver):
            return 'qr'
        if is_sms_code_step(driver):
            return 'sms'
        if 'collectemailphone' in url or 'idvbyphone' in url:
            time.sleep(1)
            continue
        if find_phone_field(driver):
            print('Found #emailPhone — phone-first flow available')
            return 'phone'
        time.sleep(1)
    if is_gmail_picker_page(driver):
        return 'username'
    if find_phone_field(driver):
        return 'phone'
    return 'timeout'


def attempt_direct_phone_entry(driver, phone_number):
    """Original flow: enter phone in #emailPhone right after birthday (no Gmail step)."""
    if is_gmail_picker_page(driver):
        print('On Gmail picker page — not a phone-first step')
        return False

    print('Phone-first: checking for phone field after birthday...')
    for attempt in range(1, 13):
        time.sleep(2)
        if is_gmail_picker_page(driver):
            print('Gmail page appeared — stopping direct phone entry')
            return False
        if is_sms_code_step(driver):
            print('Already on SMS step (direct phone path)')
            return True
        if find_phone_field(driver):
            print('Phone field found — entering number (phone-first flow)')
            driver.save_screenshot('before_phone_step.png')
            if not type_into_phone_field(driver, phone_number):
                return False
            print('Entered phone:', phone_number)
            if not click_next_button(driver):
                return False
            print('Phone submitted')
            time.sleep(3)
            if is_phone_rejected(driver):
                driver.save_screenshot('phone_rejected.png')
                print('Phone number rejected')
                return False
            try:
                WebDriverWait(driver, 20).until(
                    EC.presence_of_element_located((By.CSS_SELECTOR, '#code, input[name="code"]'))
                )
                print('SMS verification page loaded')
                return True
            except TimeoutException:
                driver.save_screenshot('no_sms_page_after_phone.png')
                print('ERROR: SMS page not shown after direct phone entry')
                return False
        if is_username_step(driver) or is_password_step(driver) or is_qr_verification_page(driver):
            print('Google showed email/password/QR step — falling back to phone navigator')
            return False
    print('No phone field after birthday within timeout')
    return False


def advance_to_phone_step(driver, first_name, last_name, password='', flow_state=None):
    """Navigate signup pages until phone input or SMS step. Phone-first — avoids Gmail unless required."""
    flow_state = flow_state if flow_state is not None else {}
    for step in range(1, 15):
        if not driver_alive(driver):
            print('ERROR: Browser closed while waiting for phone step')
            return False
        time.sleep(1.5)
        try:
            url = driver.current_url
        except (NoSuchWindowException, WebDriverException):
            print('ERROR: Browser closed while reading signup URL')
            return False
        print(f'Waiting for phone step ({step}/15) — URL: {url}')

        if step == 1:
            try:
                driver.save_screenshot('after_birthday.png')
            except Exception:
                pass

        if is_sms_code_step(driver):
            print('Already on SMS code step')
            return True

        if find_phone_field(driver):
            print('Phone input found')
            driver.save_screenshot('before_phone_step.png')
            return True

        if is_outbound_sms_verification(driver):
            driver.save_screenshot('outbound_sms_verification.png')
            flow_state['qr_blocked'] = True
            print(
                'ERROR: Google requires outbound Send SMS verification — '
                '5SIM virtual numbers cannot send SMS. Try VPN/fresh residential IP.'
            )
            return False

        if is_qr_verification_page(driver):
            driver.save_screenshot('qr_verification_page.png')
            print('QR verification page detected — trying to switch to phone/SMS entry')
            if switch_qr_to_phone_entry(driver):
                continue
            flow_state['qr_blocked'] = True
            print('ERROR: Google QR verification cannot be bypassed — use VPN/fresh IP')
            return False

        if is_password_step(driver):
            print('Password step before phone — filling password then continuing to phone')
            if password and fill_password_step(driver, password):
                flow_state['password_done'] = True
                continue
            print('ERROR: Could not complete password step')
            driver.save_screenshot('password_step_failed.png')
            return False

        if is_username_step(driver):
            print('Google showed Gmail username page')
            # Do NOT run try_skip_email here — it can misfire and skip Gmail selection.
            # Wait for suggestions, pick one, then continue to password/phone.
            try:
                WebDriverWait(driver, 10).until(
                    lambda d: d.find_elements(
                        By.XPATH,
                        "//div[@role='radio' and contains(., '@gmail.com')]"
                        " | //*[contains(text(), '@gmail.com')]"
                        " | //*[@id='username']"
                        " | //input[@name='Username']",
                    ) or is_password_step(d)
                )
            except TimeoutException:
                print('Gmail suggestions did not appear — continuing anyway')
            except (NoSuchWindowException, InvalidSessionIdException):
                print('ERROR: Browser closed waiting for Gmail suggestions')
                return False

            if find_phone_field(driver):
                continue
            if is_password_step(driver):
                print('Page already advanced to password — filling it next')
                continue

            print('Completing Gmail step (required by Google on this IP), then 5SIM phone verification')
            log_visible_actions(driver)
            selected_email = handle_username_step(driver, first_name, last_name)
            if selected_email:
                if selected_email != '__password_reached__':
                    flow_state['email'] = selected_email
                    print(f'Gmail selected: {selected_email} — continuing to phone step')
                else:
                    print('Username step already passed — continuing to password/phone')
                continue
            if not driver_alive(driver):
                print('ERROR: Browser closed during Gmail username step')
                return False
            if is_password_step(driver):
                print('Recovered: password page is showing after username attempt')
                continue
            print('ERROR: Could not complete Gmail username step')
            try:
                driver.save_screenshot('username_step_failed.png')
            except Exception:
                pass
            return False

        if is_optional_email_step(driver):
            print('Skipping optional email step')
            click_element_with_text(driver, 'skip', 'not now', 'no thanks')
            click_next_button(driver)
            time.sleep(2)
            continue

        if click_next_button(driver):
            time.sleep(2)
            continue

        driver.save_screenshot('phone_step_failed.png')
        print('ERROR: Stuck before phone step')
        return False

    driver.save_screenshot('phone_step_failed.png')
    print('ERROR: Timed out waiting for phone step')
    return False


def is_phone_rejected(driver):
    page_text = driver.page_source.lower()
    return 'used too many times' in page_text or 'this phone number cannot be used' in page_text


def submit_phone_number(driver, phone_number, first_name=None, last_name=None, password='', flow_state=None):
    flow_state = flow_state if flow_state is not None else {}

    # If already on Gmail/username page, go straight to navigator (don't spin waiting for #emailPhone)
    if is_username_step(driver) or is_gmail_picker_page(driver):
        print('On Gmail step — selecting address then continuing to phone verification')
    elif attempt_direct_phone_entry(driver, phone_number):
        flow_state['phone_first'] = True
        return True

    if not advance_to_phone_step(driver, first_name or '', last_name or '', password, flow_state):
        return False

    if is_sms_code_step(driver):
        print('On SMS step already — phone was accepted')
        return True

    if not type_into_phone_field(driver, phone_number):
        driver.save_screenshot('phone_field_missing.png')
        print('ERROR: Could not enter phone number')
        return False

    print('Entered phone:', phone_number)

    if not click_next_button(driver):
        print('ERROR: Could not click Next on phone step')
        driver.save_screenshot('phone_next_missing.png')
        return False

    print('Phone submitted')
    time.sleep(3)

    if is_phone_rejected(driver):
        driver.save_screenshot('phone_rejected.png')
        print('Phone number rejected')
        return False

    try:
        WebDriverWait(driver, 20).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, '#code, input[name="code"]'))
        )
        print('SMS verification page loaded')
        return True
    except TimeoutException:
        driver.save_screenshot('no_sms_page_after_phone.png')
        print('ERROR: Google did not show SMS code page after phone submit')
        print('URL:', driver.current_url)
        return False


def apply_phone_country_fingerprint(driver, phone_number=''):
    """Align browser locale/geo with the purchased SMS number."""
    phone = (phone_number or '').replace(' ', '')
    try:
        if phone.startswith('+31'):
            driver.execute_cdp_cmd('Emulation.setTimezoneOverride', {'timezoneId': 'Europe/Amsterdam'})
            driver.execute_cdp_cmd('Emulation.setLocaleOverride', {'locale': 'nl-NL'})
            driver.execute_cdp_cmd('Emulation.setGeolocationOverride', {
                'latitude': 52.3676,
                'longitude': 4.9041,
                'accuracy': 100,
            })
        elif phone.startswith('+1'):
            driver.execute_cdp_cmd('Emulation.setTimezoneOverride', {'timezoneId': 'America/Toronto'})
            driver.execute_cdp_cmd('Emulation.setLocaleOverride', {'locale': 'en-CA'})
            driver.execute_cdp_cmd('Emulation.setGeolocationOverride', {
                'latitude': 43.6532,
                'longitude': -79.3832,
                'accuracy': 100,
            })
        else:
            driver.execute_cdp_cmd('Emulation.setTimezoneOverride', {'timezoneId': 'Europe/London'})
            driver.execute_cdp_cmd('Emulation.setLocaleOverride', {'locale': 'en-GB'})
            driver.execute_cdp_cmd('Emulation.setGeolocationOverride', {
                'latitude': 51.5074,
                'longitude': -0.1278,
                'accuracy': 100,
            })
    except Exception as exc:
        print('CDP geo/locale note:', exc)


def apply_netherlands_fingerprint(driver):
    apply_phone_country_fingerprint(driver, '+31')


def build_chrome_driver(chrome_profile, mobile=False, phone_number=''):
    options = webdriver.ChromeOptions()
    options.add_argument(f'--user-data-dir={chrome_profile}')
    options.add_argument('--no-first-run')
    options.add_argument('--no-default-browser-check')
    options.add_argument('--disable-blink-features=AutomationControlled')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument('--disable-features=TranslateUI,AutomationControlled')
    options.add_argument('--window-size=1280,900')
    # --disable-gpu can crash Chrome 150 on macOS; keep GPU enabled on Darwin
    if sys.platform != 'darwin':
        options.add_argument('--disable-gpu')
    lang = 'en-CA' if (phone_number or '').startswith('+1') else 'en-US'
    options.add_argument(f'--lang={lang}')
    options.add_experimental_option('excludeSwitches', ['enable-automation', 'enable-logging'])
    options.add_experimental_option('useAutomationExtension', False)
    options.set_capability('goog:loggingPrefs', {'browser': 'WARNING'})
    if mobile:
        options.add_experimental_option('mobileEmulation', {
            'deviceMetrics': {'width': 412, 'height': 915, 'pixelRatio': 2.625},
            'userAgent': (
                'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 '
                '(KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36'
            ),
        })
    else:
        options.add_argument('--start-maximized')

    driver = webdriver.Chrome(
        service=Service(ChromeDriverManager().install()),
        options=options,
    )
    driver.set_page_load_timeout(60)
    driver.implicitly_wait(0)
    try:
        driver.execute_cdp_cmd('Page.addScriptToEvaluateOnNewDocument', {
            'source': 'Object.defineProperty(navigator, "webdriver", {get: () => undefined})',
        })
    except WebDriverException as exc:
        print('CDP stealth note:', exc)
    # Soft fingerprint only — skip geolocation override (it can crash some Chrome builds)
    try:
        phone = (phone_number or '').replace(' ', '')
        if phone.startswith('+1'):
            driver.execute_cdp_cmd('Emulation.setTimezoneOverride', {'timezoneId': 'America/Toronto'})
            driver.execute_cdp_cmd('Emulation.setLocaleOverride', {'locale': 'en-CA'})
        elif phone.startswith('+31'):
            driver.execute_cdp_cmd('Emulation.setTimezoneOverride', {'timezoneId': 'Europe/Amsterdam'})
            driver.execute_cdp_cmd('Emulation.setLocaleOverride', {'locale': 'nl-NL'})
        else:
            driver.execute_cdp_cmd('Emulation.setTimezoneOverride', {'timezoneId': 'Europe/London'})
            driver.execute_cdp_cmd('Emulation.setLocaleOverride', {'locale': 'en-GB'})
    except WebDriverException as exc:
        print('CDP locale note:', exc)
    return driver


def fill_field_slow(driver, element_id, value):
    field = WebDriverWait(driver, 20).until(
        EC.element_to_be_clickable((By.ID, element_id))
    )
    field.click()
    time.sleep(0.2)
    select_all_key = Keys.COMMAND if sys.platform == 'darwin' else Keys.CONTROL
    ActionChains(driver).key_down(select_all_key).send_keys('a').key_up(select_all_key).perform()
    time.sleep(0.1)
    ActionChains(driver).send_keys(Keys.DELETE).perform()
    time.sleep(0.2)
    for char in value:
        ActionChains(driver).send_keys(char).perform()
        time.sleep(0.05)
    time.sleep(0.3)


def fill_name_and_birthday(driver, first_name, last_name, month_str, day_str, year_str):
    """Fill name + birthday and return post-birthday step type."""
    fill_field_slow(driver, 'firstName', first_name)
    fill_field_slow(driver, 'lastName', last_name)
    WebDriverWait(driver, 20).until(
        EC.element_to_be_clickable((By.CSS_SELECTOR, '#collectNameNext button'))
    ).click()
    print('Name submitted')
    time.sleep(2)

    WebDriverWait(driver, 30).until(EC.presence_of_element_located((By.ID, 'month')))
    month_dropdown = WebDriverWait(driver, 20).until(
        EC.element_to_be_clickable((
            By.CSS_SELECTOR,
            '#month div[role="combobox"], #month > div > div.VfPpkd-TkwUic > div',
        ))
    )
    month_dropdown.click()
    time.sleep(1)
    month_index = int(month_str)
    WebDriverWait(driver, 20).until(
        EC.element_to_be_clickable((By.CSS_SELECTOR, f'#month ul li:nth-child({month_index + 1})'))
    ).click()

    driver.find_element(By.ID, 'day').send_keys(day_str)
    driver.find_element(By.ID, 'year').send_keys(year_str)

    gender_dropdown = WebDriverWait(driver, 20).until(
        EC.element_to_be_clickable((By.CSS_SELECTOR, '#gender > div > div.VfPpkd-TkwUic > div'))
    )
    gender_dropdown.click()
    time.sleep(1)
    gender_options = driver.find_elements(By.CSS_SELECTOR, '#gender ul li')
    if gender_options:
        gender_options[min(2, len(gender_options) - 1)].click()
    else:
        WebDriverWait(driver, 20).until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, '#gender ul li:nth-child(3)'))
        ).click()

    WebDriverWait(driver, 20).until(
        EC.element_to_be_clickable((By.CSS_SELECTOR, '#birthdaygenderNext button'))
    ).click()
    print('Birthday and gender submitted')
    time.sleep(2)
    WebDriverWait(driver, 30).until(
        lambda d: 'birthdaygender' not in d.current_url.lower()
    )
    time.sleep(2)
    print('Page after birthday:', driver.current_url)
    print('Page title:', driver.title)
    return wait_for_email_phone_field(driver, timeout=20)


def launch_phone_first_signup(first_name, last_name, month_str, day_str, year_str, phone_number=''):
    """Open Google signup once and continue through Gmail → phone → SMS (no full restart on username step)."""
    last_driver = None
    last_profile = None
    last_step = 'timeout'
    continue_steps = ('username', 'password', 'qr', 'phone', 'sms')

    for attempt in PHONE_FIRST_SIGNUP_ATTEMPTS:
        if last_driver:
            last_driver.quit()
        if last_profile and os.path.isdir(last_profile):
            shutil.rmtree(last_profile, ignore_errors=True)

        profile = tempfile.mkdtemp(prefix='yt_signup_chrome_')
        mobile = attempt['mobile']
        print(f"Signup attempt: {attempt['name']} (mobile={mobile})")
        driver = build_chrome_driver(profile, mobile=mobile, phone_number=phone_number)
        last_driver = driver
        last_profile = profile

        try:
            driver.get(attempt['url'])
            print('Opened:', driver.current_url)
            print('Title:', driver.title)
            time.sleep(2)

            if find_phone_field(driver) or 'idvbyphone' in driver.current_url.lower():
                print('Phone entry page detected at signup start')

            step = fill_name_and_birthday(driver, first_name, last_name, month_str, day_str, year_str)
            last_step = step
            if step in ('phone', 'sms'):
                print(f"Phone field ready via {attempt['name']}")
                return driver, profile, step
            if step in continue_steps:
                print(
                    f"Signup at '{step}' after birthday via {attempt['name']} — "
                    'continuing same session (Gmail then phone verification)'
                )
                return driver, profile, step
            print(f"{attempt['name']} timed out waiting for next step — trying next URL...")
        except Exception as exc:
            print(f"{attempt['name']} failed: {exc}")
            driver.save_screenshot(f'signup_error_{attempt["name"]}.png')
            continue

    if last_driver:
        print('WARNING: Signup did not reach a known step — continuing with last browser session')
        return last_driver, last_profile, last_step if last_step != 'timeout' else 'username'

    return None, None, 'timeout'


def finish_signup_wizard(driver, password, password_already_done=False):
    """Complete remaining signup pages after SMS (password if needed, opt-in, agree)."""
    if not password_already_done and is_password_step(driver):
        if not fill_password_step(driver, password):
            return False

    for _ in range(10):
        time.sleep(1.5)
        if is_password_step(driver) and not password_already_done:
            fill_password_step(driver, password)
            password_already_done = True
            continue

        if click_element_with_text(driver, 'skip', 'not now', 'no thanks', 'later'):
            time.sleep(1)
            continue

        for css in (
            '#optIn > div > button',
            '#optIn button',
            'button[jsname="LgbsSe"]',
        ):
            try:
                btn = driver.find_element(By.CSS_SELECTOR, css)
                if btn.is_displayed():
                    js_click_el(driver, btn)
                    print('Clicked opt-in / next button')
                    time.sleep(1.5)
                    break
            except Exception:
                continue
        else:
            if click_next_button(driver):
                time.sleep(1.5)
                continue

        page = driver.page_source.lower()
        if any(p in page for p in ('welcome to your google account', 'your account is ready', 'myaccount.google.com')):
            print('Signup wizard complete')
            return True

        if click_element_with_text(driver, 'i agree', 'agree', 'accept'):
            time.sleep(2)
            return True

    return True


def main():
    base_dir = os.path.dirname(__file__)

    first_name = os.getenv('SCRIPT_FIRST_NAME') or read_first_line(os.path.join(base_dir, 'nameFirst.txt'))
    last_name = os.getenv('SCRIPT_LAST_NAME') or read_first_line(os.path.join(base_dir, 'nameLast.txt'))
    birthday_line = os.getenv('SCRIPT_BIRTHDAY') or read_first_line(os.path.join(base_dir, 'birthday.txt'))
    month_str, day_str, year_str = birthday_line.split()
    password = os.getenv('SCRIPT_PASSWORD') or read_first_line(os.path.join(base_dir, 'password.txt'))

    account_ctx = {
        'firstName': first_name,
        'lastName': last_name,
        'phone': '',
        'password': password,
        'birthday': birthday_line,
    }

    print(f'Using name: {first_name} {last_name}, birthday: {birthday_line}')

    five_sim_handler = FiveSimAPIHandler()
    active_phone_number = five_sim_handler.acquire_phone_number()

    if not active_phone_number:
        emit_partial_and_exit(
            base_dir,
            account_ctx,
            "\nERROR: No phone number available. Fix 5SIM balance/stock and try again.",
        )

    account_ctx['phone'] = active_phone_number
    print("Using phone:", active_phone_number)

    driver = None
    chrome_profile = None
    active_order_id = None
    try:
        driver, chrome_profile, post_birthday = launch_phone_first_signup(
            first_name, last_name, month_str, day_str, year_str, active_phone_number
        )
        if not driver:
            emit_partial_and_exit(
                base_dir,
                account_ctx,
                'ERROR: Could not start Chrome for signup — check Chrome/ChromeDriver',
            )
        print(f'Using fresh Chrome profile: {chrome_profile}')

        if post_birthday == 'phone':
            print('Phone-first flow: #emailPhone ready after birthday')
        elif post_birthday == 'username':
            print('Still on Gmail step — will enter phone after navigating past it if needed')

        active_order_id = (
            getattr(five_sim_handler, "activation_order_id", None)
            or getattr(five_sim_handler, "active_order_id", None)
        )
        print("Using order ID for SMS poll:", active_order_id)

        flow_state = {}
        if not submit_phone_number(
            driver, active_phone_number, first_name, last_name, password, flow_state
        ):
            if flow_state.get('email'):
                account_ctx['email'] = flow_state['email']
            if active_order_id:
                five_sim_handler.cancel_order(active_order_id)
            if flow_state.get('qr_blocked'):
                emit_partial_and_exit(
                    base_dir,
                    account_ctx,
                    'ERROR: Google blocked with QR/Send-SMS verification — use VPN/residential IP and retry',
                )
            emit_partial_and_exit(
                base_dir,
                account_ctx,
                'ERROR: Signup stopped before phone/SMS step — partial account saved',
            )

        driver.save_screenshot("after_phone_submit.png")

        sms_count_before = five_sim_handler.get_sms_count(active_order_id)
        print(f"SMS count before poll: {sms_count_before}")

        # Poll for a NEW SMS (count must exceed sms_count_before)
        sms_code = five_sim_handler.get_sms_code(active_order_id, known_count=sms_count_before)

        if not sms_code:
            account_ctx['email'] = flow_state.get('email', '')
            if active_order_id:
                five_sim_handler.cancel_order(active_order_id)
            emit_partial_and_exit(
                base_dir,
                account_ctx,
                'No SMS code received from 5SIM',
            )

        code_field = WebDriverWait(driver, 20).until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, '#code, input[name="code"]'))
        )
        code_field.clear()
        code_field.send_keys(sms_code)
        print('Entered SMS code:', sms_code)

        click_next_button(driver)
        print('SMS code submitted')
        time.sleep(2)

        if active_order_id:
            five_sim_handler.finish_order(active_order_id)
            active_order_id = None

        if not finish_signup_wizard(driver, password, flow_state.get('password_done', False)):
            account_ctx['email'] = flow_state.get('email') or detect_gmail_from_page(driver)
            emit_partial_and_exit(base_dir, account_ctx, 'ERROR: Could not finish signup wizard after SMS')

        email = flow_state.get('email') or detect_gmail_from_page(driver)
        account_data = {
            'firstName': first_name,
            'lastName': last_name,
            'email': email,
            'phone': active_phone_number,
            'password': password,
        }
        save_created_account(base_dir, account_data)

        with open(os.path.join(base_dir, 'account.txt'), 'a', encoding='utf-8') as f:
            f.write(f'{email or active_phone_number} | {active_phone_number} | {password}\n')
        print(f'Account saved — phone: {active_phone_number}' + (f', gmail: {email}' if email else ''))
        if email:
            print(f'ACCOUNT_CREATED email={email} phone={active_phone_number}')
        else:
            print(f'ACCOUNT_CREATED phone={active_phone_number}')
            print(f'ACCOUNT_PHONE={active_phone_number}')

        driver.save_screenshot('account_created.png')

    except (NoSuchWindowException, WebDriverException) as exc:
        account_ctx['email'] = account_ctx.get('email') or ''
        if active_order_id:
            five_sim_handler.cancel_order(active_order_id)
        emit_partial_and_exit(
            base_dir,
            account_ctx,
            f'ERROR: Browser closed during signup ({exc.__class__.__name__}) — partial account saved',
        )
    finally:
        if driver:
            try:
                driver.quit()
            except Exception:
                pass
        if chrome_profile and os.path.isdir(chrome_profile):
            shutil.rmtree(chrome_profile, ignore_errors=True)


if __name__ == '__main__':
    main()