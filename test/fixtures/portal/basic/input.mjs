import createFetcher from './create-fetcher';
import knex from 'knex';

export const fetchProjects = createFetcher(async () => {
	const db = knex();

	const projects = await db('projects').select();

	return projects;
});

module.exports = function () {
	return fetchProjects();
};
