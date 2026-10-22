<?php
if (!defined('ABSPATH')) exit;

class Ordyx_Shipping_Method extends WC_Shipping_Method {
    public function __construct($instance_id = 0) {
        $this->id = 'ordyx';
        $this->instance_id = absint($instance_id);
        $this->method_title = 'Ordyx – Еконт / Спиди / BOX NOW';
        $this->method_description = 'Доставка с избор на офис или автомат в чекаута (Ordyx). Добавете по един метод за всеки куриер и начин, с вашата цена.';
        $this->supports = ['shipping-zones', 'instance-settings', 'instance-settings-modal'];
        $this->init_form_fields();
        $this->init_settings();
        $this->title = $this->get_option('title', 'Еконт – офис или автомат');
        add_action('woocommerce_update_options_shipping_' . $this->id, [$this, 'process_admin_options']);
    }

    public function init_form_fields() {
        $this->instance_form_fields = [
            'ordyx_type' => ['title' => 'Куриер и начин', 'type' => 'select', 'options' => Ordyx_Api::TYPES, 'default' => 'econt_office'],
            'title' => ['title' => 'Име в чекаута', 'type' => 'text', 'default' => 'Еконт – офис или автомат', 'desc_tip' => true, 'description' => 'Каквото клиентът вижда като начин на доставка'],
            'cost' => ['title' => 'Цена', 'type' => 'price', 'default' => '5', 'description' => 'С ДДС, както клиентът я плаща'],
            'free_over' => ['title' => 'Безплатна над', 'type' => 'price', 'default' => '', 'description' => 'Сума на поръчката, над която доставката е безплатна. Празно = никога'],
        ];
    }

    public function calculate_shipping($package = []) {
        $type = (string) $this->get_option('ordyx_type', 'econt_office');
        if ($type === 'boxnow_locker' && !Ordyx_Api::boxnow_enabled()) return; // the shop has not switched BOX NOW on in Ordyx
        $cost = (float) $this->get_option('cost', 0);
        $free = (string) $this->get_option('free_over', '');
        $subtotal = isset($package['contents_cost']) ? (float) $package['contents_cost'] : (WC()->cart ? (float) WC()->cart->get_subtotal() : 0);
        if ($free !== '' && $subtotal >= (float) $free) $cost = 0;
        $this->add_rate([
            'id'        => $this->get_rate_id(),
            'label'     => $this->title,
            'cost'      => $cost,
            'package'   => $package,
            'meta_data' => ['ordyx_type' => $type],
        ]);
    }
}
