import os
import json
import time
import re
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv

dotenv_path = os.getenv('DOTENV_PATH')
if dotenv_path and os.path.isfile(dotenv_path):
    load_dotenv(dotenv_path)
else:
    load_dotenv()


class FiveSimAPIHandler:
    DEFAULT_COUNTRY = 'any'
    DEFAULT_OPERATOR = 'any'
    DEFAULT_PRODUCT = 'google'
    # Prefer countries that historically deliver Google SMS; order matters for "any".
    FALLBACK_COUNTRIES = (
        'canada',
        'england',
        'indonesia',
        'netherlands',
        'romania',
        'usa',
    )
    # Only reuse a RECEIVED order if it was created this recently (seconds).
    REUSE_MAX_AGE_SECONDS = 90

    def __init__(self):
        self.api_key = os.getenv('FIVESIM_API_KEY') or os.getenv('5SIM_API_KEY')
        self.base_url = 'https://5sim.net/v1'
        self.headers = {
            'Authorization': f'Bearer {self.api_key}',
            'Accept': 'application/json',
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
        try:
            response = requests.get(f'{self.base_url}/user/profile', headers=self.headers, timeout=30)
            response.raise_for_status()
            profile_data = response.json()
            balance = float(profile_data.get('balance', 0.0) or 0.0)
            print(f'5SIM Account Balance: {balance}')
            return balance
        except Exception as e:
            print(f'Error fetching profile balance: {str(e)}')
            return None

    def cancel_order(self, order_id):
        if not order_id:
            return False
        try:
            response = requests.get(
                f'{self.base_url}/user/cancel/{order_id}',
                headers=self.headers,
                timeout=30,
            )
            print(f'Cancel order {order_id}: {response.status_code} {response.text[:120]}')
            return response.ok
        except Exception as e:
            print(f'Error canceling order {order_id}: {e}')
            return False

    def finish_order(self, order_id):
        if not order_id:
            return False
        try:
            response = requests.get(
                f'{self.base_url}/user/finish/{order_id}',
                headers=self.headers,
                timeout=30,
            )
            print(f'Finish order {order_id}: {response.status_code} {response.text[:120]}')
            return response.ok
        except Exception as e:
            print(f'Error finishing order {order_id}: {e}')
            return False

    def _parse_created_at(self, value):
        if not value:
            return None
        try:
            text = str(value).replace('Z', '+00:00')
            return datetime.fromisoformat(text)
        except Exception:
            return None

    def _order_age_seconds(self, order):
        created = self._parse_created_at(order.get('created_at'))
        if not created:
            return None
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - created).total_seconds()

    def buy_activation_number(self, country='netherlands', operator='any', product='google', forwarding=False, reuse=False, voice=False):
        try:
            params = {
                'forwarding': str(forwarding).lower(),
                'reuse': str(reuse).lower(),
                'voice': str(voice).lower(),
            }
            response = requests.get(
                f'{self.base_url}/user/buy/activation/{country}/{operator}/{product}',
                headers=self.headers,
                params=params,
                timeout=45,
            )
            body = response.text.strip()
            print(f'Buy attempt ({country}/{operator}/{product}): {body[:220]}')

            if not response.ok:
                print(f'5SIM buy failed ({response.status_code}): {body}')
                return (None, None)

            try:
                order_data = response.json()
            except json.JSONDecodeError:
                print(f'5SIM buy failed: {body}')
                return (None, None)

            if not isinstance(order_data, dict) or not order_data.get('phone'):
                print(f'5SIM buy returned no phone: {body[:220]}')
                return (None, None)

            self.activation_phone = order_data.get('phone')
            self.activation_order_id = order_data.get('id')
            self.active_phone_number = self.activation_phone
            self.active_order_id = self.activation_order_id
            print(f'Bought activation phone number: {self.activation_phone}')
            print(f'Generated order ID: {self.activation_order_id}')
            return (self.activation_order_id, self.activation_phone)
        except Exception as e:
            print(f'Error buying activation number: {str(e)}')
            return (None, None)

    def get_product_offers(self, country, product='google'):
        """Return [(operator, cost, count), ...] sorted cheapest first with stock > 0."""
        try:
            response = requests.get(
                f'{self.base_url}/guest/prices',
                params={'country': country, 'product': product},
                headers={'Accept': 'application/json'},
                timeout=30,
            )
            response.raise_for_status()
            data = response.json()
            ops = data.get(country) or data
            if isinstance(ops, dict) and product in ops:
                ops = ops[product]
            offers = []
            if isinstance(ops, dict):
                for operator, info in ops.items():
                    if not isinstance(info, dict):
                        continue
                    cost = info.get('cost', info.get('price'))
                    count = int(info.get('count') or 0)
                    if cost is None or count <= 0:
                        continue
                    offers.append((operator, float(cost), count))
            offers.sort(key=lambda item: item[1])
            return offers
        except Exception as e:
            print(f'Price lookup failed for {country}/{product}: {e}')
            return []

    def buy_cheapest_available(self, countries, product='google', max_price=None):
        """Buy the cheapest in-stock Google number across countries within max_price."""
        for country in countries:
            offers = self.get_product_offers(country, product)
            if not offers:
                print(f'No in-stock {product} offers for {country}')
                continue
            for operator, cost, count in offers:
                if max_price is not None and cost > max_price:
                    print(f'Skip {country}/{operator} cost={cost} > balance={max_price}')
                    continue
                print(f'Trying cheapest stock: {country}/{operator} cost={cost} count={count}')
                order_id, phone = self.buy_activation_number(
                    country=country,
                    operator=operator,
                    product=product,
                )
                if phone:
                    return order_id, phone
        return (None, None)

    def buy_activation_number_with_fallback(self, countries=None, operator='any', product='google', max_price=None):
        country_list = countries or self.FALLBACK_COUNTRIES
        if operator and operator != 'any':
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
        return self.buy_cheapest_available(country_list, product=product, max_price=max_price)

    def get_recent_activation_orders(self, limit=15, order_id=None):
        try:
            params = {
                'category': 'activation',
                'limit': limit,
                'offset': 0,
                'order': 'id',
                'reverse': 'true',
            }
            response = requests.get(
                f'{self.base_url}/user/orders',
                headers=self.headers,
                params=params,
                timeout=30,
            )
            response.raise_for_status()
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

            processed_orders = []
            for order in orders:
                if isinstance(order, str):
                    try:
                        processed_orders.append(json.loads(order))
                    except json.JSONDecodeError:
                        continue
                elif isinstance(order, dict):
                    processed_orders.append(order)

            valid_orders = [
                order
                for order in processed_orders
                if order.get('phone') and order.get('status') == 'RECEIVED'
            ]
            print(f'Debug: Found {len(valid_orders)} active RECEIVED orders with phone numbers')

            if order_id:
                target_order = next(
                    (order for order in valid_orders if str(order.get('id')) == str(order_id)),
                    None,
                )
                if target_order:
                    self.activation_phone = target_order.get('phone')
                    self.activation_order_id = target_order.get('id')
                    return self.activation_phone
                print(f'No existing RECEIVED order found with ID: {order_id}')
                return None

            return valid_orders
        except Exception as e:
            print(f'Error fetching recent orders: {str(e)}')
            return None

    def cancel_stale_received_orders(self, product='google'):
        """Cancel old RECEIVED orders so we never reuse burned/stale numbers."""
        orders = self.get_recent_activation_orders(limit=20) or []
        canceled = 0
        for order in orders:
            if (order.get('product') or '').lower() != product:
                continue
            age = self._order_age_seconds(order)
            sms = order.get('sms') or []
            # Keep only brand-new empty orders from this run window.
            if age is not None and age <= self.REUSE_MAX_AGE_SECONDS and not sms:
                print(
                    f'Keeping fresh RECEIVED order {order.get("id")} '
                    f'({order.get("phone")}) age={int(age)}s'
                )
                continue
            print(
                f'Canceling stale RECEIVED order {order.get("id")} '
                f'({order.get("phone")}) age={None if age is None else int(age)}s sms={len(sms)}'
            )
            if self.cancel_order(order.get('id')):
                canceled += 1
        return canceled

    def pick_fresh_received_order(self, product='google'):
        orders = self.get_recent_activation_orders(limit=10) or []
        for order in orders:
            if (order.get('product') or '').lower() != product:
                continue
            age = self._order_age_seconds(order)
            sms = order.get('sms') or []
            if age is not None and age <= self.REUSE_MAX_AGE_SECONDS and not sms:
                return order
        return None

    def acquire_phone_number(self, country=None, operator=None, product=None):
        """Cancel stale numbers, then buy a fresh Google activation number."""
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
            f'operator={settings["operator"]}, product={settings["product"]}, balance={balance}'
        )

        canceled = self.cancel_stale_received_orders(product=settings['product'])
        if canceled:
            print(f'Canceled {canceled} stale RECEIVED order(s)')

        fresh = self.pick_fresh_received_order(product=settings['product'])
        if fresh:
            self.activation_phone = fresh.get('phone')
            self.activation_order_id = fresh.get('id')
            self.active_phone_number = self.activation_phone
            self.active_order_id = self.activation_order_id
            print(f'Reusing fresh 5SIM number: {self.active_phone_number} (order {self.active_order_id})')
            return self.active_phone_number

        print('Buying a fresh 5SIM Google activation number...')
        countries = (
            self.FALLBACK_COUNTRIES
            if settings['country'] == 'any'
            else [settings['country'], *self.FALLBACK_COUNTRIES]
        )
        # De-dupe while keeping order
        seen = set()
        country_list = []
        for item in countries:
            if item not in seen:
                seen.add(item)
                country_list.append(item)

        order_id, phone = self.buy_activation_number_with_fallback(
            countries=country_list,
            operator=settings['operator'],
            product=settings['product'],
            max_price=balance,
        )
        if phone:
            return phone

        print(
            'ERROR: Could not buy a 5SIM Google number. '
            f'Balance={balance}. Add funds or set FIVESIM_COUNTRY to a cheaper market '
            '(canada/indonesia) in .env.'
        )
        return None

    def get_sms_count(self, order_id):
        try:
            response = requests.get(
                f'{self.base_url}/user/check/{order_id}',
                headers=self.headers,
                timeout=30,
            )
            response.raise_for_status()
            return len(response.json().get('sms') or [])
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
        print(f'Polling for SMS code on order {order_id} (existing SMS count: {known_count})...')
        for attempt in range(1, max_attempts + 1):
            try:
                response = requests.get(
                    f'{self.base_url}/user/check/{order_id}',
                    headers=self.headers,
                    timeout=30,
                )
                response.raise_for_status()
                order_data = response.json()
                status = order_data.get('status')
                print(f'Check order status={status} raw={response.text[:220]}')
                if status in ('CANCELED', 'TIMEOUT', 'BANNED'):
                    print(f'Order ended with status {status} — stop SMS poll')
                    return None
                sms_list = order_data.get('sms') or []
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
        try:
            response = requests.get(
                f'{self.base_url}/user/check/{order_id}',
                headers=self.headers,
                timeout=30,
            )
            response.raise_for_status()
            order_data = response.json()
            self.activation_phone = order_data.get('phone')
            print(
                f'Order {order_id}: phone={self.activation_phone} '
                f'status={order_data.get("status")} operator={order_data.get("operator")}'
            )
            return order_data
        except Exception as e:
            print(f'Error retrieving order details: {str(e)}')
            return None


if __name__ == '__main__':
    handler = FiveSimAPIHandler()
    bal = handler.get_profile_balance()
    print('Balance:', bal)
    phone = handler.acquire_phone_number()
    print('Acquired:', phone, 'order:', handler.activation_order_id)
