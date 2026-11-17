#pragma once
#include <stddef.h>
#include "FreeRTOS.h"
typedef void *QueueHandle_t;
QueueHandle_t xQueueCreate(unsigned count, unsigned size);
BaseType_t xQueueSend(QueueHandle_t queue, const void *item, unsigned wait);
BaseType_t xQueueReceive(QueueHandle_t queue, void *item, unsigned wait);
