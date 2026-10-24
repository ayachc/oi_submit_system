// 修改这里即可调整考试名称、题目和考生展示信息。
export const examConfig = {
  title: '2026-CSP-Junior',
  status: 'ongoing',
  password: null,
  problems: ['a', 'b', 'c', 'd'],
};

export const userConfig = {
  name: '考生',
  school: '第100中学',
  grade: '高三',
  room: '日新楼机房',
};

// 考号与登录用户名一致，启动时自动创建范围内的全部账号。
export const accountConfig = {
  prefix: 'LN-',
  start: 1,
  end: 999,
  password: 'abc123',
};
