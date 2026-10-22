<?php
if (!defined('ABSPATH')) exit;

/** Talks to Ordyx with the shop's key; builds the order payload Ordyx takes (POST /api/orders). */
class Ordyx_Api {
    const TYPES = [
        'econt_office'   => 'Еконт – офис или автомат',
        'econt_address'  => 'Еконт – до адрес',
        'speedy_office'  => 'Спиди – офис или автомат',
        'speedy_address' => 'Спиди – до адрес',
        'boxnow_locker'  => 'BOX NOW – автомат',
    ];
    const OFFICE_TYPES = ['econt_office', 'speedy_office', 'boxnow_locker'];
    const ADDRESS_TYPES = ['econt_address', 'speedy_address'];

    /** Where the server talks to Ordyx. */
    public static function base() { return rtrim((string) apply_filters('ordyx_api_url', ORDYX_API_URL), '/'); }
    /** Where the customer's browser loads the picker from (the same, unless a dev setup says otherwise). */
    public static function browser_base() { return rtrim(defined('ORDYX_BROWSER_URL') ? ORDYX_BROWSER_URL : self::base(), '/'); }
    public static function key() { return trim((string) get_option('ordyx_key', '')); }
    public static function mode() { return get_option('ordyx_mode', 'checkout') === 'orders' ? 'orders' : 'checkout'; }
    public static function complete_on_ship() { return get_option('ordyx_complete_on_ship', 'yes') !== 'no'; }
    public static function host() { return strtolower((string) wp_parse_url(home_url(), PHP_URL_HOST)); }

    /** What the plugin says about itself on every call (Ordyx shows it in Интеграции). */
    public static function site_header() {
        return wp_json_encode(['restUrl' => rest_url(), 'mode' => self::mode(), 'version' => ORDYX_VERSION]);
    }

    /** @return array{ok:bool,status:int,data:array,error:string} */
    private static function request($method, $path, $body = null, $timeout = 8) {
        $key = self::key();
        if (!$key) return ['ok' => false, 'status' => 0, 'data' => [], 'error' => 'Няма ключ на магазина — поставете го в WooCommerce → Ordyx'];
        $res = wp_remote_request(self::base() . $path, [
            'method'  => $method,
            'timeout' => $timeout,
            'headers' => [
                'Authorization' => 'Bearer ' . $key,
                'Content-Type'  => 'application/json',
                'X-Ordyx-Site'  => self::site_header(),
            ],
            'body' => $body === null ? null : wp_json_encode($body),
        ]);
        if (is_wp_error($res)) return ['ok' => false, 'status' => 0, 'data' => [], 'error' => $res->get_error_message()];
        $status = (int) wp_remote_retrieve_response_code($res);
        $data = json_decode((string) wp_remote_retrieve_body($res), true);
        if (!is_array($data)) $data = [];
        $error = $status >= 200 && $status < 300 ? '' : (isset($data['error']) ? (string) $data['error'] : 'Ordyx отговори ' . $status);
        return ['ok' => $error === '', 'status' => $status, 'data' => $data, 'error' => $error];
    }

    /** „Провери връзката“. */
    public static function ping() { return self::request('GET', '/api/orders'); }

    public static function send_order(WC_Order $order, $timeout = 8) {
        return self::request('POST', '/api/orders', self::payload($order), $timeout);
    }

    public static function cancel_order(WC_Order $order) {
        return self::request('POST', '/api/orders', ['source' => 'woocommerce', 'external_id' => (string) $order->get_id(), 'status' => 'cancelled']);
    }

    /** The Ordyx delivery type of the order: from the checkout choice, else from its Ordyx shipping method, else 'other'. */
    public static function order_type(WC_Order $order) {
        $type = (string) $order->get_meta('_ordyx_type');
        if ($type && isset(self::TYPES[$type])) return $type;
        foreach ($order->get_shipping_methods() as $m) {
            if ($m->get_method_id() === 'ordyx') {
                $t = Ordyx_Shipping::type_of_instance((int) $m->get_instance_id());
                if ($t) return $t;
            }
        }
        return 'other';
    }

    /** The order as Ordyx takes it: prices the customer paid (tax included), shipping inside the total. */
    public static function payload(WC_Order $order) {
        $type = self::order_type($order);
        $items = [];
        foreach ($order->get_items() as $item) {
            $qty = max(1, (int) $item->get_quantity());
            $paid = ((float) $item->get_total() + (float) $item->get_total_tax()) / $qty;
            $product = $item->get_product();
            $items[] = [
                'name'  => $item->get_name(),
                'qty'   => $qty,
                'price' => round($paid, 2),
                'sku'   => $product ? (string) $product->get_sku() : '',
            ];
        }
        $name = trim($order->get_shipping_first_name() . ' ' . $order->get_shipping_last_name());
        if ($name === '') $name = trim($order->get_billing_first_name() . ' ' . $order->get_billing_last_name());
        $phone = $order->get_shipping_phone() ?: $order->get_billing_phone();
        $city = $order->get_shipping_city() ?: $order->get_billing_city();
        $post = $order->get_shipping_postcode() ?: $order->get_billing_postcode();
        $address = trim($order->get_shipping_address_1() . ' ' . $order->get_shipping_address_2());
        if ($address === '') $address = trim($order->get_billing_address_1() . ' ' . $order->get_billing_address_2());
        $office_id = '';
        $office_text = '';
        $address_text = '';
        if (in_array($type, self::OFFICE_TYPES, true)) {
            $office_id = (string) $order->get_meta('_ordyx_office_id');
            $office_text = (string) $order->get_meta('_ordyx_office_text');
            $city = (string) $order->get_meta('_ordyx_city') ?: $city;
            $post = (string) $order->get_meta('_ordyx_post_code') ?: $post;
        } elseif (in_array($type, self::ADDRESS_TYPES, true)) {
            $address_text = $address;
            $office_text = ($type === 'econt_address' ? 'ЕКОНТ' : 'СПИДИ') . ' – адрес: ' . $address;
        } else {
            $office_text = $order->get_shipping_method() ?: 'Доставка';
            $address_text = $address;
        }
        return [
            'source'         => 'woocommerce',
            'external_id'    => (string) $order->get_id(),
            'name'           => $name,
            'phone'          => (string) $phone,
            'email'          => (string) $order->get_billing_email(),
            'delivery_type'  => $type,
            'office_id'      => $office_id,
            'office_text'    => $office_text,
            'city'           => (string) $city,
            'post_code'      => (string) $post,
            'address_text'   => $address_text,
            'items'          => $items,
            'total'          => round((float) $order->get_total(), 2),
            'currency'       => $order->get_currency(),
            'paid'           => $order->get_payment_method() !== 'cod' && $order->is_paid(), // a COD order is never "paid" here, whatever its status
            'payment_method' => $order->get_payment_method() === 'cod' ? 'cod' : 'card',
            'page_url'       => (string) $order->get_created_via(),
        ];
    }

    /** The shop's office list from Ordyx (cached a day): to check the chosen office when the order is placed. */
    public static function offices($courier, $fresh = false) {
        $key = 'ordyx_offices_' . $courier . '_' . substr(md5(self::base()), 0, 8); // per Ordyx host: a dev setup switching hosts never checks against a stale list
        $cached = $fresh ? false : get_transient($key);
        if (is_array($cached)) return $cached;
        $res = wp_remote_get(self::base() . '/api/offices?courier=' . rawurlencode($courier), ['timeout' => 4]);
        if (is_wp_error($res) || (int) wp_remote_retrieve_response_code($res) !== 200) return null;
        $data = json_decode((string) wp_remote_retrieve_body($res), true);
        if (!is_array($data) || !isset($data['offices']) || !is_array($data['offices'])) return null;
        $ids = [];
        foreach ($data['offices'] as $o) if (isset($o['id'])) $ids[(string) $o['id']] = 1;
        set_transient($key, $ids, DAY_IN_SECONDS);
        return $ids;
    }

    /** Whether Ordyx says BOX NOW is switched on for this shop (cached 10 minutes; unknown = shown). */
    public static function boxnow_enabled() {
        $cached = get_transient('ordyx_boxnow_on');
        if ($cached !== false) return $cached === 'yes';
        $res = wp_remote_get(self::base() . '/api/offices?courier=shop&host=' . rawurlencode(self::host()), ['timeout' => 4]);
        $on = 'yes';
        if (!is_wp_error($res) && (int) wp_remote_retrieve_response_code($res) === 200) {
            $data = json_decode((string) wp_remote_retrieve_body($res), true);
            if (is_array($data) && array_key_exists('boxnow', $data)) $on = $data['boxnow'] ? 'yes' : 'no';
        }
        set_transient('ordyx_boxnow_on', $on, 10 * MINUTE_IN_SECONDS);
        return $on === 'yes';
    }
}
