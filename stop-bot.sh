#!/bin/bash

echo "🔍 Поиск запущенных процессов бота..."

# Находим процессы Node.js, которые могут быть нашим ботом
BOT_PROCESSES=$(ps aux | grep -E "(node.*index\.js|node.*dist/index\.js|ts-node.*index\.ts)" | grep -v grep)

if [ -z "$BOT_PROCESSES" ]; then
    echo "✅ Запущенных процессов бота не найдено"
else
    echo "📋 Найденные процессы:"
    echo "$BOT_PROCESSES"
    echo ""
    
    # Получаем PID процессов
    PIDS=$(echo "$BOT_PROCESSES" | awk '{print $2}')
    
    echo "🛑 Останавливаем процессы..."
    for pid in $PIDS; do
        echo "Останавливаем процесс $pid"
        kill -TERM $pid 2>/dev/null || echo "Не удалось остановить процесс $pid"
    done
    
    # Ждем 2 секунды
    sleep 2
    
    # Проверяем, остались ли процессы
    REMAINING=$(ps aux | grep -E "(node.*index\.js|node.*dist/index\.js|ts-node.*index\.ts)" | grep -v grep)
    if [ ! -z "$REMAINING" ]; then
        echo "⚠️  Некоторые процессы все еще работают, принудительная остановка..."
        for pid in $PIDS; do
            kill -KILL $pid 2>/dev/null || echo "Не удалось принудительно остановить процесс $pid"
        done
    fi
    
    echo "✅ Процессы остановлены"
fi

echo "🚀 Теперь можно запустить бота: npm run dev"
