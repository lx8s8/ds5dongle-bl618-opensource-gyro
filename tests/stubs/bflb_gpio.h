#pragma once
#include <stdint.h>
struct bflb_device_s { int unused; };
#define GPIO_PIN_2 2
#define GPIO_PIN_12 12
#define GPIO_PIN_14 14
#define GPIO_PIN_15 15
#define GPIO_PIN_27 27
#define GPIO_PIN_28 28
#define GPIO_PIN_29 29
#define GPIO_OUTPUT 1
#define GPIO_PULLUP 2
#define GPIO_SMT_EN 4
#define GPIO_DRV_0 8
void bflb_gpio_init(struct bflb_device_s *, uint32_t, uint32_t);
void bflb_gpio_set(struct bflb_device_s *, uint32_t);
void bflb_gpio_reset(struct bflb_device_s *, uint32_t);
struct bflb_device_s *bflb_device_get_by_name(const char *);
