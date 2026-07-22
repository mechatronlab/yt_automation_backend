import os
import sys
import json
import time
import re
import requests
from dotenv import load_dotenv

# Load environment variables (Node passes DOTENV_PATH to project root .env)
dotenv_path = os.getenv('DOTENV_PATH')
if dotenv_path and os.path.isfile(dotenv_path):
    load_dotenv(dotenv_path)
else:
    load_dotenv()

class FiveSimAPIHandler:
    DEFAULT_COUNTRY = 'any'
    DEFAULT_OPERATOR = 'any'
    DEFAULT_PRODUCT = 'google'
    FALLBACK_COUNTRIES = ('netherlands', 'canada', 'romania', 'england', 'indonesia', 'usa')

    def __init__(self):
        self.api_key = os.getenv('FIVESIM_API_KEY') or os.getenv('5SIM_API_KEY')
        self.base_url = 'https://5sim.net/v1'
        # Add required Accept header per 5SIM official docs
        self.headers = {
            'Authorization': f'Bearer {self.api_key}',
            'Accept': 'application/json'
        }
        self.activation_phone = None
        self.activation_order_id = None
        self.active_phone_number = None
        self.active_order_id = None

    def get_purchase_settings(self, country=None, operator=None, product=None):
        return {
            'country': (country or os.getenv('FIVESIM_COUNTRY') or self.DEFAULT_COUNTRY).strip().lower(),
            'operator': (operator or os.getenv('FIVESIM_OPERATOR') or self.DEFAULT_OPERATOR).strip().lower(),
            'product': (product or os.getenv('FIVESIM_PRODUCT') or self.DEFAULT_PRODUCT).strip().lower(),
        }

    def get_profile_balance(self):
        """Get user profile data and check balance"""
        try:
            response = requests.get(f'{self.base_url}/user/profile', headers=self.headers)
            response.raise_for_status()
            profile_data = response.json()
            balance = profile_data.get('balance', 0.0)
            print(f'5SIM Account Balance: {balance}')
            return balance
        except Exception as e:
            print(f'Error fetching profile balance: {str(e)}')
            return None

    def buy_activation_number(self, country='netherlands', operator='any', product='google', forwarding=False, reuse=False, voice=False):
        """Buy activation number (returns order ID + phone number) using 5SIM's official buy endpoint"""
        try:
            params = {
                'forwarding': str(forwarding).lower(),
                'reuse': str(reuse).lower(),
                'voice': str(voice).lower()
            }
            response = requests.get(
                f'{self.base_url}/user/buy/activation/{country}/{operator}/{product}',
                headers=self.headers,
                params=params
            )
            body = response.text.strip()
            print(f'Buy attempt ({country}/{operator}/{product}): {body[:200]}')

            if not response.ok:
                print(f'5SIM buy failed ({response.status_code}): {body}')
                return (None, None)

            try:
                order_data = response.json()
            except json.JSONDecodeError:
                print(f'5SIM buy failed: {body}')
                return (None, None)

            self.activation_phone = order_data.get('phone', None)
            self.activation_order_id = order_data.get('id', None)
            print(f'Bought activation phone number: {self.activation_phone}')
            print(f'Generated order ID: {self.activation_order_id}')
            return (self.activation_order_id, self.activation_phone)
        except Exception as e:
            if 'response' in locals():
                print(f'Error Raw Response: {response.text}')
            print(f'Error buying activation number: {str(e)}')
            return (None, None)

    def buy_activation_number_with_fallback(
        self,
        countries=None,
        operator='any',
        product='google',
    ):
        """Try buying a number from several countries until one succeeds."""
        country_list = countries or self.FALLBACK_COUNTRIES
        for country in country_list:
            print(f'Trying to buy {product} number in {country} (operator: {operator})...')
            order_id, phone = self.buy_activation_number(
                country=country,
                operator=operator,
                product=product,
            )
            if phone:
                return order_id, phone
        return (None, None)

    def acquire_phone_number(
        self,
        country=None,
        operator=None,
        product=None,
    ):
        """Reuse an active order or auto-buy a new Google activation number."""
        if not self.api_key:
            print('ERROR: Missing FIVESIM_API_KEY in .env file')
            return None

        balance = self.get_profile_balance()
        if balance is None:
            print('ERROR: Could not verify 5SIM account (check API key)')
            return None
        if balance <= 0:
            print('ERROR: 5SIM balance is zero — add funds at https://5sim.net')
            return None

        settings = self.get_purchase_settings(country, operator, product)
        print(
            f'5SIM auto settings: country={settings["country"]}, '
            f'operator={settings["operator"]}, product={settings["product"]}'
        )

        self.get_recent_activation_orders()
        if getattr(self, 'active_phone_number', None):
            self.activation_phone = self.active_phone_number
            self.activation_order_id = getattr(self, 'active_order_id', None)
            print(f'Reusing active 5SIM number: {self.active_phone_number}')
            return self.active_phone_number

        print('No reusable 5SIM order found — auto-buying a new activation number...')
        order_id, phone = self.buy_activation_number(**settings)
        if phone:
            self.activation_order_id = order_id
            self.active_order_id = order_id
            self.active_phone_number = phone
            self.activation_phone = phone
            return phone

        if settings['country'] == 'any':
            print('Country "any" unavailable — trying fallback countries...')
            order_id, phone = self.buy_activation_number_with_fallback(
                operator=settings['operator'],
                product=settings['product'],
            )
            if phone:
                self.activation_order_id = order_id
                self.active_order_id = order_id
                self.active_phone_number = phone
                self.activation_phone = phone
                return phone

        print('ERROR: Could not auto-buy a 5SIM Google activation number. Check balance/stock.')
        return None

    def get_recent_activation_orders(self, limit=15, order_id=None):
        """Get recent activation orders (filter by order ID if provided)"""
        try:
            params = {
                'category': 'activation',
                'limit': limit,
                'offset': 0,
                'order': 'id',
                'reverse': 'true'
            }
            response = requests.get(f'{self.base_url}/user/orders', headers=self.headers, params=params)
            response.raise_for_status()
            # Log full raw response to diagnose unparseable string entries
            print(f'Debug: Full raw orders endpoint response: {response.text[:1000]}...')
            try:
                response_data = response.json()
                if isinstance(response_data, list):
                    orders = response_data
                elif isinstance(response_data, dict):
                    orders = (
                        response_data.get('Data')
                        or response_data.get('data')
                        or response_data.get('orders')
                        or []
                    )
                else:
                    orders = []
            except json.JSONDecodeError:
                error_msg = f'5SIM API returned malformed JSON orders response: {response.text[:500]}...'
                print(error_msg)
                return None
            print(f'Recent activation orders fetched: {len(orders)}')

            # Debug: Log each order's type and content to identify invalid entries
            print('Debug: Inspecting recent order entries:')
            for idx, order in enumerate(orders):
                print(f'  Order {idx+1}: Type={type(order).__name__}, Content={str(order)[:200]}...')

            # Fix: Parse string entries to dictionaries if possible (handles API's mixed response format)
            processed_orders = []
            for order in orders:
                if isinstance(order, str):
                    try:
                        # Attempt to parse string entry into JSON dictionary
                        parsed_order = json.loads(order)
                        processed_orders.append(parsed_order)
                        print(f'Debug: Successfully parsed string entry to dictionary')
                    except json.JSONDecodeError:
                        print(f'Debug: Skipping unparseable string entry')
                        continue
                else:
                    processed_orders.append(order)

            # Filter for valid dictionary orders with phone numbers (only active RECEIVED status)
            valid_orders = [order for order in processed_orders if isinstance(order, dict) and 'phone' in order and order.get('status') == 'RECEIVED']
            print(f'Debug: Found {len(valid_orders)} active purchased orders with phone numbers')

            # Filter for specific order ID if provided (safe handling for non-dictionary order entries)
            if order_id:
                target_order = next((order for order in valid_orders if str(order.get('id')) == str(order_id)), None)
                if target_order:
                    self.activation_phone = target_order.get('phone', None)
                    print(f'Existing activation phone number retrieved: {self.activation_phone}')
                    return self.activation_phone
                else:
                    print(f'No existing order found with ID: {order_id}')
                    return None

            # Return first active phone number for integration with youtube_signin.py
            if valid_orders:
                self.active_phone_number = valid_orders[0].get('phone')
                self.active_order_id = valid_orders[0].get('id')
                self.activation_order_id = self.active_order_id
                print(f'Active phone number ready for YouTube sign-in: {self.active_phone_number}')
            return valid_orders
        except Exception as e:
            if 'response' in locals():
                print(f'Error Raw Orders Response: {response.text[:500]}...')
            print(f'Error fetching recent orders: {str(e)}')
            return None

    def get_sms_count(self, order_id):
        """Return the current number of SMS messages on an order."""
        try:
            response = requests.get(f'{self.base_url}/user/check/{order_id}', headers=self.headers)
            response.raise_for_status()
            return len(response.json().get('sms', []))
        except Exception:
            return 0

    def _extract_google_code(self, msg):
        code = str(msg.get('code', '') or '').strip()
        text = str(msg.get('text', '') or '')
        if code and re.fullmatch(r'\d{4,8}', code) and 'g.co' not in code.lower():
            return code
        match = re.search(r'G-(\d{6})', text)
        if match:
            return match.group(1)
        match = re.search(r'\b(\d{6})\b', text)
        if match and 'verification' in text.lower():
            return match.group(1)
        return None

    def get_sms_code(self, order_id, known_count=0, max_attempts=36, interval=5):
        """Poll until a NEW SMS arrives. Max wait: 36 x 5s = 3 minutes."""
        print(f'Polling for SMS code on order {order_id} (existing SMS count: {known_count})...')
        for attempt in range(1, max_attempts + 1):
            try:
                response = requests.get(
                    f'{self.base_url}/user/check/{order_id}',
                    headers=self.headers
                )
                response.raise_for_status()
                order_data = response.json()
                print(f'Raw check response: {response.text[:300]}')
                sms_list = order_data.get('sms', [])
                if len(sms_list) > known_count:
                    for msg in reversed(sms_list[known_count:]):
                        code = self._extract_google_code(msg)
                        if code:
                            print(f'New SMS code received: {code}')
                            return code
            except Exception as e:
                print(f'Attempt {attempt} error: {str(e)}')
            print(f'Attempt {attempt}/{max_attempts}: waiting for new SMS, sleeping {interval}s...')
            time.sleep(interval)
        print('Timed out waiting for new SMS code.')
        return None

    def get_order_details(self, order_id):
        """Retrieve existing order details using 5SIM's official Check Order endpoint (matches your provided spec)"""
        try:
            # Use order_id in URL path per your spec: https://5sim.net/v1/user/check/{order_id}
            response = requests.get(
                f'{self.base_url}/user/check/{order_id}',
                headers=self.headers
            )
            response.raise_for_status()
            print(f'Raw Official Order Response: {response.text}')
            order_data = response.json()
            # Extract key details per 5SIM docs (includes operator from your spec)
            self.activation_phone = order_data.get('phone', None)
            order_service = order_data.get('product', None)
            order_country = order_data.get('country', None)
            order_operator = order_data.get('operator', None)
            order_status = order_data.get('status', None)
            print(f'Official Order Details:')
            print(f'  Phone Number: {self.activation_phone}')
            print(f'  Service: {order_service}')
            print(f'  Country: {order_country}')
            print(f'  Operator: {order_operator}')
            print(f'  Status: {order_status}')
            # Return full order data for further use
            return order_data
        except requests.exceptions.HTTPError as e:
            if 'response' in locals():
                print(f'HTTP Error Raw Response: {response.text[:500]}...')
            print(f'HTTP Error retrieving order details: {str(e)}')
            return None
        except json.JSONDecodeError:
            error_msg = f'5SIM API returned non-JSON response (fixed headers applied): {response.text[:500]}...'
            print(error_msg)
            return None
        except Exception as e:
            if 'response' in locals():
                print(f'Unexpected error: {response.text[:500]}...')
            print(f'Error processing order data: {str(e)}')
            return None
        except Exception as e:
            if 'response' in locals():
                print(f'Error Raw Official Order Response: {response.text[:500]}...')
            print(f'Error retrieving official order details: {str(e)}')
            return None


            return None

    def check_activation_inventory(self, country='nl', operator='any', product='google'):
        """Check available activation phone inventory (5SIM has no dedicated inventory endpoint)"""
        print(f'Note: 5SIM API does not provide a working dedicated inventory check endpoint (verified 404 for multiple path attempts)')
        print(f'Cannot pre-verify available phones for {country}/{operator}/{product} — will rely on buy endpoint response')
        # Return None to indicate pre-check is not possible
        return None

if __name__ == '__main__':
    handler = FiveSimAPIHandler()
    handler.get_profile_balance()
    # --------------------------
    # Fetch phone numbers from your purchased orders list
    print('Fetching all purchased phone numbers from your account...')
    recent_orders = handler.get_recent_activation_orders(limit=10)
    if not recent_orders:
        print('Error: No recent purchased orders found in your account')
    else:
        # Filter valid purchased orders with phone numbers
        valid_purchased_orders = [
            order for order in recent_orders
            if isinstance(order, dict) and 'phone' in order and order['phone'] is not None
        ]
        if not valid_purchased_orders:
            print(f'Error: No valid purchased orders with phone numbers found in {len(recent_orders)} recent orders')
        else:
            print(f'Successfully found {len(valid_purchased_orders)} purchased phone numbers:')
            for idx, order in enumerate(valid_purchased_orders, 1):
                print(f'  {idx}. Order ID: {order.get("id")}, Phone Number: {order.get("phone")}, Service: {order.get("product")}')
    # --------------------------
    # Direct buy flow (uses official 5SIM buy + check endpoints — optional)
    print('\nStarting optional direct number purchase & verification flow...')
    # Customize country/operator/product here (matches your endpoint requirements)
    # order_id, phone_number = handler.buy_activation_number(country='nl', operator='any', product='google')
    # if order_id and phone_number:
    #     print(f'Direct purchase successful: Order ID = {order_id}, Phone Number = {phone_number}')
    #     # Verify order details with official Check Order endpoint
    #     print(f'Verifying order via official /user/check endpoint...')
    #     verified_order = handler.get_order_details(order_id=order_id)
    #     if verified_order:
    #         print(f'Order verification complete: Confirmed phone = {verified_order.get("phone")}, Operator = {verified_order.get("operator")}')
    # else:
    #     print('Direct purchase failed — check above API response details')
    # --------------------------
    # Optional: Auto-fetch recent orders (uncomment to use)
    # print('Auto-fetching latest activation order ID from your account...')
    # recent_orders = handler.get_recent_activation_orders(limit=4)
    # if not recent_orders:
    #     print('Error: No recent activation orders found in your account')
    # else:
    #     # Filter valid order dictionaries and find first with ID
    #     valid_orders = [order for order in recent_orders if isinstance(order, dict) and 'id' in order]
    #     if not valid_orders:
    #         print(f'Error: No valid orders with ID found in {len(recent_orders)} recent orders')
    #     else:
    #         # Get latest valid order (sorted by reverse ID in get_recent_activation_orders)
    #         latest_valid_order = valid_orders[0]
    #         order_id = str(latest_valid_order['id'])
    #         print(f'Using latest valid order ID: {order_id}')
    # --------------------------
    # Option 2: Attempt new purchase (commented out to prioritize existing order retrieval)
    # inventory_count = handler.check_activation_inventory(country='nl', product='google')
    # if inventory_count is None:
    #     print('Proceeding with purchase attempt since inventory pre-check is unavailable')
    #     handler.buy_activation_number(country='nl', product='google')
    # elif inventory_count > 0:
    #     handler.buy_activation_number(country='nl', product='google')
    # else:
    #     print('No available phones for selected parameters — skipping purchase attempt')