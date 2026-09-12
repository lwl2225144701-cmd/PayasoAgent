// 示例/演示工具（已从核心 coding tools 移出）：calculator / getWeather
// Registration is triggered by application bootstrap so importing the Runtime
// kernel has no product-tool side effects.

import { register } from './tools.js';

register({
  name: 'calculator',
  description: '计算数学表达式，支持加减乘除和括号',
  effect: 'idempotent',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '数学表达式，如 15 * 37' },
    },
    required: ['expression'],
  },
  execute: async (args) => {
    const expression = String(args.expression || '');
    if (!/^[0-9+\-*/().\s]+$/.test(expression)) {
      throw new Error('表达式包含非法字符');
    }
    try {
      const result = Function(`"use strict"; return (${expression})`)();
      return `计算结果: ${expression} = ${result}`;
    } catch {
      throw new Error('表达式无法计算');
    }
  },
  validateResult: (result) => {
    const match = String(result).match(/= (.+)$/);
    const value = match ? match[1].trim() : String(result);
    if (value === 'NaN' || value === 'Infinity' || value === '-Infinity') {
      return { valid: false, reason: `计算结果无效: ${value}` };
    }
    return true;
  },
});

const WEATHER_MOCK: Record<string, { temp: number; cond: string }> = {
  深圳: { temp: 28, cond: '晴' },
  北京: { temp: 15, cond: '多云' },
  上海: { temp: 22, cond: '小雨' },
};

register({
  name: 'getWeather',
  description: '查询指定城市的当前天气（温度与天气状况），仅支持已收录城市',
  effect: 'read',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: '城市名称，如 深圳' },
    },
    required: ['city'],
  },
  execute: async (args) => {
    const city = String(args.city || '').trim();
    if (!city) throw new Error('缺少城市参数 city');
    const weather = WEATHER_MOCK[city];
    if (!weather) throw new Error('城市不存在或天气数据获取失败');
    if (process.env.INVALID_WEATHER === '1') {
      return JSON.stringify({ city, temperature: null });
    }
    return `天气: ${city} ${weather.temp}°C, ${weather.cond}`;
  },
  validateResult: (result) => {
    try {
      const json = JSON.parse(String(result));
      if (json && (json.temperature === null || json.temperature === undefined)) {
        return { valid: false, reason: 'temperature 缺失或为空' };
      }
      if (typeof json.temperature !== 'number' || !Number.isFinite(json.temperature)) {
        return { valid: false, reason: 'temperature 不是有效数值' };
      }
      return true;
    } catch {
      const match = String(result).match(/(\d+(?:\.\d+)?)°C/);
      if (!match) return { valid: false, reason: '无法解析温度' };
      return true;
    }
  },
});
