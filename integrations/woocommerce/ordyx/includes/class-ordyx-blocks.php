<?php
if (!defined('ABSPATH')) exit;

use Automattic\WooCommerce\StoreApi\Schemas\V1\CheckoutSchema;
use Automattic\WooCommerce\StoreApi\Exceptions\RouteException;

/** The block checkout: the picker in the shipping area (assets/checkout-blocks.js) sends the choice as Store API extension data. */
class Ordyx_Blocks {
    public static function init() {
        if (Ordyx_Api::mode() !== 'checkout') return;
        add_action('woocommerce_blocks_loaded', [__CLASS__, 'register']);
        add_action('woocommerce_store_api_checkout_update_order_from_request', [__CLASS__, 'from_request'], 10, 2);
    }

    public static function register() {
        if (!function_exists('woocommerce_store_api_register_endpoint_data')) return;
        woocommerce_store_api_register_endpoint_data([
            'endpoint'        => CheckoutSchema::IDENTIFIER,
            'namespace'       => 'ordyx',
            'schema_callback' => function () {
                $s = ['type' => 'string', 'context' => ['view', 'edit'], 'readonly' => false];
                return ['type' => $s, 'office_id' => $s, 'office_text' => $s, 'city' => $s, 'post_code' => $s];
            },
            'schema_type' => ARRAY_A,
        ]);
    }

    public static function from_request($order, $request) {
        $type = '';
        foreach ($order->get_shipping_methods() as $m) {
            if ($m->get_method_id() === 'ordyx') { $type = Ordyx_Shipping::type_of_instance((int) $m->get_instance_id()); break; }
        }
        if (!$type) return;
        $ext = $request['extensions']['ordyx'] ?? [];
        $v = [
            'office_id'   => sanitize_text_field((string) ($ext['office_id'] ?? '')),
            'office_text' => sanitize_text_field((string) ($ext['office_text'] ?? '')),
            'city'        => sanitize_text_field((string) ($ext['city'] ?? '')),
            'post_code'   => sanitize_text_field((string) ($ext['post_code'] ?? '')),
        ];
        $err = Ordyx_Checkout::check($type, $v['office_id']);
        if ($err) throw new RouteException('ordyx_office', $err, 400);
        Ordyx_Checkout::apply($order, $type, $v);
    }
}
